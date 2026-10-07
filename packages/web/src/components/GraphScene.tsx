import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from "react";
import * as THREE from "three";
import type { Cluster, ClusterEdge } from "../clusters";
import type { Layout, PositionedNode } from "../layout";

/** Hues for colouring by directory, spread out so neighbours are easy to tell apart. */
const DIRECTORY_HUES = [0.53, 0.09, 0.35, 0.78, 0.14, 0.47, 0.93, 0.62, 0.24, 0.86];

/** The dark background everything sits on. Same as `--field` in tokens.css. */
const FIELD = "#0b1020";

/**
 * The importance colours, like fluorescent stains: dim cyan for the long tail, then cyan,
 * green and amber for files that matter. Same as `--importance-ramp` in tokens.css, which
 * the toolbar legend uses, so the legend matches the nodes.
 */
const RAMP = [
  { at: 0, color: new THREE.Color("#2b6f88") },
  { at: 0.35, color: new THREE.Color("#4fd1e8") },
  { at: 0.65, color: new THREE.Color("#7be08a") },
  { at: 1, color: new THREE.Color("#f2b84b") },
];

export type ColorMode = "importance" | "directory";

/**
 * "tool" is the explorer at /graph. "showcase" is the landing page hero: it slowly spins
 * on its own, can't be zoomed (so the page still scrolls under your mouse) and doesn't
 * select nodes.
 */
export type SceneMode = "tool" | "showcase";

export interface SceneProps {
  layout: Layout;
  /** Nodes below this importance get dimmed and shrunk. */
  threshold: number;
  colorMode: ColorMode;
  selectedIndex?: number;
  /** Indices to highlight because an answer cited them. */
  citedIndices: number[];
  onSelect(index: number): void;
  /**
   * Per node index: 1 for files folded into a collapsed folder bubble. Hidden files are
   * drawn at size zero so they can't be clicked, and their edges and labels are skipped.
   */
  hidden?: Uint8Array;
}

/** Folder bubbles drawn instead of the files of collapsed folders. */
export interface ClusterView {
  clusters: Cluster[];
  edges: ClusterEdge[];
  /** Per cluster index: 1 while it's collapsed into a bubble. */
  collapsed: Uint8Array;
  selected?: number;
  onSelect(cluster: number): void;
}

function colorFor(
  positioned: PositionedNode,
  mode: ColorMode,
  directories: string[],
  target: THREE.Color,
): THREE.Color {
  if (mode === "directory") {
    const hue = DIRECTORY_HUES[directories.indexOf(positioned.directory) % DIRECTORY_HUES.length]!;
    return target.setHSL(hue, 0.62, 0.62);
  }

  return rampColor(positioned.node.importance, target);
}

/**
 * Importance looks like PageRank, with almost every file near zero, so the colour uses
 * sqrt(importance). Same curve as node size. It spreads out the long tail enough that the
 * middle colours actually show up.
 */
function rampColor(importance: number, target: THREE.Color): THREE.Color {
  const t = Math.sqrt(Math.min(1, Math.max(0, importance)));
  for (let i = 1; i < RAMP.length; i++) {
    const lower = RAMP[i - 1]!;
    const upper = RAMP[i]!;
    if (t <= upper.at) {
      return target.copy(lower.color).lerp(upper.color, (t - lower.at) / (upper.at - lower.at));
    }
  }
  return target.copy(RAMP[RAMP.length - 1]!.color);
}

/**
 * Node radius in world units, as a fraction of the framing radius instead of a fixed
 * size.
 *
 * Fixed sizes only look right at one scale. With 1.6 + sqrt(importance) * 5.4, a typical
 * node was a nice 7px on a 26-file graph and 0.40px on an 18,851-file one: there, not
 * clipped, but way too small to see. That's why the big scene still looked empty after
 * the clipping fix. Scaling with the framing radius keeps nodes the same size on screen,
 * about 3.5px for a typical one and 14px for the most important, whatever the graph size.
 */
function radiusFor(positioned: PositionedNode, framingRadius: number): number {
  const t = Math.min(1, Math.max(0, positioned.node.importance));
  return framingRadius * (0.006 + 0.018 * Math.sqrt(t));
}

/**
 * Every node is an instance of one mesh, so the whole graph is a single draw call no
 * matter how big. Thousands of separate meshes would each cost a draw call and kill the
 * framerate long before the node count did. That's also why the importance threshold
 * fades and shrinks nodes instead of unmounting them.
 */
function Nodes({
  layout,
  threshold,
  colorMode,
  selectedIndex,
  citedIndices,
  onSelect,
  nodeScale,
  framing,
  hidden,
}: SceneProps & { nodeScale: number; framing: number }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const cited = useMemo(() => new Set(citedIndices), [citedIndices]);

  const scratch = useMemo(
    () => ({ matrix: new THREE.Matrix4(), color: new THREE.Color(), position: new THREE.Vector3() }),
    [],
  );

  // A unit sphere. Each node's real radius goes into its instance matrix.
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 16, 12), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const white = new THREE.Color("#ffffff");

    layout.nodes.forEach((positioned, i) => {
      const visible = positioned.node.importance >= threshold;
      const isSelected = selectedIndex === positioned.index;
      const isCited = cited.has(positioned.index);

      // Below the threshold a node stays but gets small, so it's still a landmark without
      // grabbing attention. Selected and cited nodes always show at full size.
      const emphasis = isSelected ? 1.5 : isCited ? 1.25 : 1;
      const dimming = visible || isSelected || isCited ? 1 : 0.3;
      const scale = hidden?.[positioned.index] ? 0 : radiusFor(positioned, framing) * nodeScale * emphasis * dimming;

      scratch.position.set(positioned.x, positioned.y, positioned.z);
      scratch.matrix.makeScale(scale, scale, scale).setPosition(scratch.position);
      mesh.setMatrixAt(i, scratch.matrix);

      colorFor(positioned, colorMode, layout.directories, scratch.color);
      if (isSelected) scratch.color.copy(white);
      else if (isCited) scratch.color.lerp(white, 0.45);
      else if (!visible) scratch.color.multiplyScalar(0.25);

      mesh.setColorAt(i, scratch.color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [layout, threshold, colorMode, selectedIndex, cited, scratch, nodeScale, framing, hidden]);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const instance = event.instanceId;
    if (instance === undefined) return;
    const positioned = layout.nodes[instance];
    if (positioned) onSelect(positioned.index);
  };

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, layout.nodes.length]}
      onClick={handleClick}
    >
      <meshStandardMaterial roughness={0.45} metalness={0.1} />
    </instancedMesh>
  );
}

interface Anchor {
  key: number | string;
  x: number;
  y: number;
  z: number;
  /** Shown even if it overlaps something, e.g. the selected item. */
  always?: boolean;
}

/**
 * All the labels on the map, from every layer, so we check overlaps across all of them.
 * An open folder's file names and the folder bubble names shouldn't pile on top of each
 * other any more than within their own set. Groups are checked in `GROUP_ORDER` order,
 * and anything marked `always` goes first.
 */
class LabelRegistry {
  readonly groups = new Map<string, Anchor[]>();
  readonly elements = new Map<string, HTMLElement>();
}

/** Files before folders: you opened a folder to read its file names. */
const GROUP_ORDER = ["files", "folders"];

/**
 * Register one layer's labels and get back a ref factory for their elements. Keys are
 * prefixed with the group, so a file and a folder never clash.
 */
function useLabelGroup(registry: LabelRegistry, group: string, anchors: Anchor[]) {
  useEffect(() => {
    registry.groups.set(group, anchors);
    return () => {
      registry.groups.delete(group);
    };
  }, [registry, group, anchors]);

  return useCallback(
    (key: number | string) => (element: HTMLElement | null) => {
      const id = `${group}:${key}`;
      if (element) registry.elements.set(id, element);
      else registry.elements.delete(id);
    },
    [registry, group],
  );
}

/**
 * Hide any label that would overlap one already placed. Runs a few times a second against
 * where the labels actually are on screen, so a label comes back as soon as rotating the
 * graph makes room for it.
 */
function LabelCollisions({ registry }: { registry: LabelRegistry }) {
  const camera = useThree((state) => state.camera);
  const ticks = useRef(0);
  const scratch = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (ticks.current++ % 6 !== 0) return;
    const ordered = GROUP_ORDER.flatMap((group) =>
      (registry.groups.get(group) ?? []).map((anchor) => ({ group, anchor })),
    );
    // Selected stuff first, whatever layer it's in, so it always wins.
    ordered.sort((a, b) => Number(Boolean(b.anchor.always)) - Number(Boolean(a.anchor.always)));

    const placed: Array<[number, number, number, number]> = [];
    for (const { group, anchor } of ordered) {
      const element = registry.elements.get(`${group}:${anchor.key}`);
      if (!element) continue;
      scratch.set(anchor.x, anchor.y, anchor.z).project(camera);
      const behind = scratch.z > 1;
      // Where the label really is (hidden labels still have a box). Working it out from
      // the projection drifted away from drei's placement with the panel view offset, and
      // let a file name sit on top of a folder name.
      const rect = element.getBoundingClientRect();
      const box: [number, number, number, number] = [rect.left - 1, rect.top - 1, rect.right + 1, rect.bottom + 1];
      const clash = placed.some(([l, t, r, b]) => box[0] < r && box[2] > l && box[1] < b && box[3] > t);
      const show = !behind && (anchor.always || !clash);
      element.style.visibility = show ? "visible" : "hidden";
      if (show) placed.push(box);
    }
  });

  return null;
}

/** How many of the top highlighted files get a name on the map. */
const LABEL_COUNT = 12;

/**
 * Text for a label: the file name, or `folder/file` for names that mean nothing on their
 * own, like `index.ts` or `__init__.py`. Repos have dozens of those.
 */
export function labelFor(filePath: string): string {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1] ?? filePath;
  const generic = /^(index\.[cm]?[jt]sx?|__init__\.py|mod\.rs|main\.(py|go))$/.test(name);
  return generic && parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name;
}

/**
 * Names on the map for the most important files, so you can spot them without clicking
 * around. Only the top few highlighted files and the selected one get a label; naming
 * every node would bury the graph.
 *
 * These are DOM labels (drei's Html), not 3D text. They stay sharp at any zoom, and
 * drei's 3D text builds a worker from a blob: URL, which our Content-Security-Policy
 * blocks. They sit under the panels, which have z-index 2.
 */
function Labels({
  layout,
  threshold,
  selectedIndex,
  framing,
  hidden,
  registry,
}: {
  layout: Layout;
  threshold: number;
  selectedIndex?: number;
  framing: number;
  hidden?: Uint8Array;
  registry: LabelRegistry;
}) {
  const labelled = useMemo(() => {
    const top = layout.nodes
      .filter((n) => n.node.importance >= threshold && !hidden?.[n.index])
      .sort((a, b) => b.node.importance - a.node.importance)
      .slice(0, LABEL_COUNT);
    const selected = layout.nodes.find((n) => n.index === selectedIndex);
    // Selected file goes first so it wins every overlap below.
    if (selected && !hidden?.[selected.index]) return [selected, ...top.filter((n) => n !== selected)];
    return top;
  }, [layout, threshold, selectedIndex, hidden]);

  // Two labelled files with the same name (src/flask/app.py, src/flask/sansio/app.py)
  // would look identical, so clashing names get their folder.
  const names = useMemo(() => {
    const short = labelled.map((n) => labelFor(n.node.path));
    return short.map((name, i) => {
      if (short.indexOf(name) === short.lastIndexOf(name)) return name;
      const parts = labelled[i]!.node.path.split("/");
      return parts.slice(-2).join("/");
    });
  }, [labelled]);

  const anchors = useMemo(
    () =>
      labelled.map((positioned, i) => ({
        key: positioned.index,
        x: positioned.x,
        y: positioned.y,
        z: positioned.z,
        always: i === 0 && positioned.index === selectedIndex,
      })),
    [labelled, selectedIndex],
  );
  const register = useLabelGroup(registry, "files", anchors);

  return (
    <>
      {labelled.map((positioned, i) => {
        // Lift the label just above its sphere, whose radius scales with the frame.
        const lift = radiusFor(positioned, framing) * 1.6;
        return (
          <Html
            key={positioned.index}
            position={[positioned.x, positioned.y + lift, positioned.z]}
            center
            zIndexRange={[1, 0]}
            style={{ pointerEvents: "none" }}
          >
            <span
              ref={register(positioned.index)}
              className={`node-label${positioned.index === selectedIndex ? " is-selected" : ""}`}
              title={positioned.node.path}
            >
              {names[i]}
            </span>
          </Html>
        );
      })}
    </>
  );
}

/**
 * All edges go in one LineSegments buffer, so again one draw call.
 *
 * Direction is shown with a colour gradient per vertex: each line starts dim at the
 * importer and gets brighter towards the file it imports. Arrowheads would just be
 * clutter at this density, but a gradient reads fine even zoomed out.
 */
function Edges({
  layout,
  threshold,
  opacity,
  hidden,
}: {
  layout: Layout;
  threshold: number;
  opacity: number;
  hidden?: Uint8Array;
}) {
  const geometry = useMemo(() => {
    const visible = layout.edges.filter((edge) => {
      const from = layout.nodes[edge.from];
      const to = layout.nodes[edge.to];
      return (
        from !== undefined &&
        to !== undefined &&
        !hidden?.[edge.from] &&
        !hidden?.[edge.to] &&
        from.node.importance >= threshold &&
        to.node.importance >= threshold
      );
    });

    const positions = new Float32Array(visible.length * 6);
    const colors = new Float32Array(visible.length * 6);

    const tail = new THREE.Color("#1c2645");
    const head = new THREE.Color("#4fa8c4");

    visible.forEach((edge, i) => {
      const from = layout.nodes[edge.from]!;
      const to = layout.nodes[edge.to]!;
      const offset = i * 6;

      positions[offset] = from.x;
      positions[offset + 1] = from.y;
      positions[offset + 2] = from.z;
      positions[offset + 3] = to.x;
      positions[offset + 4] = to.y;
      positions[offset + 5] = to.z;

      colors[offset] = tail.r;
      colors[offset + 1] = tail.g;
      colors[offset + 2] = tail.b;
      colors[offset + 3] = head.r;
      colors[offset + 4] = head.g;
      colors[offset + 5] = head.b;
    });

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    buffer.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return buffer;
  }, [layout, threshold, hidden]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={opacity} />
    </lineSegments>
  );
}

interface Frame {
  center: { x: number; y: number; z: number };
  radius: number;
}

/**
 * What the folders view frames: every folder bubble, not just the important files like
 * the files view. Test and example folders often sit far from the core, and cutting them
 * off would hide most of the bubbles. The centre is the middle of the bubbles' bounding
 * box, not a file-weighted centre: on home-assistant two giant overflow bubbles dragged a
 * weighted centre to one side and pushed everything else off screen.
 */
function clusterFrame(clusters: Cluster[], floor: number): Frame {
  if (clusters.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: floor };
  const mid = (axis: "x" | "y" | "z") => {
    const values = clusters.map((c) => c[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  const center = { x: mid("x"), y: mid("y"), z: mid("z") };
  const furthest = Math.max(...clusters.map((c) => Math.hypot(c.x - center.x, c.y - center.y, c.z - center.z)));
  // The camera sits 1.6 radii out. With a 55° field of view that shows about 0.8 radii
  // above and below the centre, and less when the error banner makes the canvas shorter.
  return { center, radius: Math.max(furthest * 1.4, floor) };
}

/** How many folder bubbles get a name: the biggest ones first, plus the selected one. */
const CLUSTER_LABEL_COUNT = 15;

/**
 * Folders drawn as bubbles instead of their files: one instanced mesh for the bubbles and
 * one line buffer for imports between folders, so even home-assistant's 18,932 files turn
 * into a few dozen shapes and a few hundred lines. Bubble size follows file count, colour
 * follows the most important file.
 */
function ClusterLayer({
  view,
  framing,
  registry,
}: {
  view: ClusterView;
  framing: number;
  registry: LabelRegistry;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 24, 18), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const largest = useMemo(() => Math.max(1, ...view.clusters.map((c) => c.members.length)), [view.clusters]);
  const radiusOf = (cluster: Cluster) => framing * (0.025 + 0.075 * Math.sqrt(cluster.members.length / largest));

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const white = new THREE.Color("#ffffff");
    view.clusters.forEach((cluster, i) => {
      const scale = view.collapsed[i] ? radiusOf(cluster) : 0;
      matrix.makeScale(scale, scale, scale).setPosition(cluster.x, cluster.y, cluster.z);
      mesh.setMatrixAt(i, matrix);
      rampColor(cluster.importance, color);
      if (view.selected === i) color.lerp(white, 0.6);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // radiusOf only depends on framing and largest, and both are listed.
  }, [view, framing, largest]);

  // Imports between two collapsed folders, brighter when there are more.
  const lines = useMemo(() => {
    const shown = view.edges.filter((e) => view.collapsed[e.from] && view.collapsed[e.to]);
    const heaviest = Math.max(1, ...shown.map((e) => e.weight));
    const positions = new Float32Array(shown.length * 6);
    const colors = new Float32Array(shown.length * 6);
    const dim = new THREE.Color("#1c2645");
    const bright = new THREE.Color("#4fa8c4");
    const mixed = new THREE.Color();
    shown.forEach((edge, i) => {
      const from = view.clusters[edge.from]!;
      const to = view.clusters[edge.to]!;
      positions.set([from.x, from.y, from.z, to.x, to.y, to.z], i * 6);
      mixed.copy(dim).lerp(bright, 0.25 + 0.75 * Math.log1p(edge.weight) / Math.log1p(heaviest));
      colors.set([dim.r, dim.g, dim.b, mixed.r, mixed.g, mixed.b], i * 6);
    });
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    buffer.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return buffer;
  }, [view]);
  useEffect(() => () => lines.dispose(), [lines]);

  const labelled = useMemo(() => {
    const order = view.clusters
      .map((cluster, i) => ({ cluster, i }))
      .filter(({ i }) => view.collapsed[i]);
    const top = order.slice(0, CLUSTER_LABEL_COUNT);
    const selected = order.find(({ i }) => i === view.selected);
    if (selected) return [selected, ...top.filter((entry) => entry !== selected)];
    return top;
  }, [view]);

  const anchors = useMemo(
    () =>
      labelled.map(({ cluster, i }) => ({
        key: cluster.id,
        x: cluster.x,
        y: cluster.y + radiusOf(cluster) * 1.25,
        z: cluster.z,
        always: i === view.selected,
      })),
    // radiusOf only depends on framing and largest.
    [labelled, view.selected, framing, largest],
  );
  const register = useLabelGroup(registry, "folders", anchors);

  // Bubbles overlap where the layout packs folders together, and on home-assistant two
  // huge ones sit right over the core. Once a folder is open you need to see its files
  // through them, so the others go see-through.
  const opened = view.collapsed.some((collapsed) => !collapsed);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.instanceId !== undefined && view.collapsed[event.instanceId]) view.onSelect(event.instanceId);
  };

  return (
    <>
      <lineSegments geometry={lines}>
        <lineBasicMaterial vertexColors transparent opacity={0.7} />
      </lineSegments>
      <instancedMesh ref={meshRef} args={[geometry, undefined, view.clusters.length]} onClick={handleClick}>
        <meshStandardMaterial
          roughness={0.35}
          metalness={0.05}
          transparent
          opacity={opened ? 0.18 : 0.88}
          depthWrite={!opened}
        />
      </instancedMesh>
      {labelled.map(({ cluster, i }) => (
        <Html
          key={cluster.id}
          position={[cluster.x, cluster.y + radiusOf(cluster) * 1.25, cluster.z]}
          center
          zIndexRange={[1, 0]}
          style={{ pointerEvents: "none" }}
        >
          <span
            ref={register(cluster.id)}
            className={`node-label cluster-label${view.selected === i ? " is-selected" : ""}`}
            title={cluster.folder || "(root)"}
          >
            {cluster.label} <span className="cluster-count">{cluster.members.length.toLocaleString()}</span>
          </span>
        </Html>
      ))}
    </>
  );
}

/**
 * Ease the orbit target and camera onto a focused node instead of jumping, so it's clear
 * where the view moved from.
 */
function CameraFocus({
  layout,
  focusIndex,
  focusCluster,
  radius,
  mode,
  frame,
}: {
  layout: Layout;
  focusIndex?: number;
  /**
   * A folder to fly to. Passed as an object so focusing the same one twice still moves
   * the camera.
   */
  focusCluster?: Cluster;
  radius: number;
  mode: SceneMode;
  /** What the view frames. Switching between files and folders flies to the new frame. */
  frame: Frame;
}) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const goal = useRef(new THREE.Vector3());
  const distance = useRef(radius);
  const active = useRef(false);
  // The focus effects below read this but don't depend on it. Switching between files and
  // folders changes the radius, and if it were a dependency we'd fly back to the focused
  // file and override the new view's frame, leaving the camera stuck inside the folder
  // bubbles.
  const radiusRef = useRef(radius);
  radiusRef.current = radius;

  // Orbit around the frame's centre (the important files, or the folders), not the
  // origin. Set once at mount: later frames get flown to below, and a target prop that
  // changed every render would yank the camera off a node.
  const showcase = mode === "showcase";
  const [center] = useState(() => new THREE.Vector3(frame.center.x, frame.center.y, frame.center.z));
  const firstFrame = useRef(true);

  useEffect(() => {
    if (firstFrame.current) {
      firstFrame.current = false;
      return;
    }
    goal.current.set(frame.center.x, frame.center.y, frame.center.z);
    distance.current = frame.radius * 1.6;
    active.current = true;
  }, [frame]);

  useEffect(() => {
    if (focusIndex === undefined) return;
    const positioned = layout.nodes.find((n) => n.index === focusIndex);
    if (!positioned) return;

    goal.current.set(positioned.x, positioned.y, positioned.z);

    // Show the node with its neighbours instead of filling the screen with it. The
    // minimum is half the framing radius; a fixed 45 units once put the camera inside
    // pallets/flask's cluster, with the neighbouring spheres filling the whole screen.
    const radius = radiusRef.current;
    const own = radiusFor(positioned, radius) * 14;
    distance.current = Math.min(Math.max(own, radius * 0.5), radius * 1.4);
    active.current = true;
  }, [focusIndex, layout]);

  useEffect(() => {
    if (!focusCluster) return;
    goal.current.set(focusCluster.x, focusCluster.y, focusCluster.z);
    // Frame the folder's files: far enough to see their spread, close enough that they
    // look the same size as in the files view.
    const radius = radiusRef.current;
    distance.current = Math.min(Math.max(focusCluster.spread * 2.4, radius * 0.35), radius * 1.4);
    active.current = true;
  }, [focusCluster]);

  useFrame((state, delta) => {
    const orbit = controls.current;
    if (!orbit || !active.current) return;

    const smoothing = 1 - Math.exp(-6 * delta);
    orbit.target.lerp(goal.current, smoothing);

    // Move along the current view direction, so focusing never spins the scene.
    const desired = goal.current
      .clone()
      .add(state.camera.position.clone().sub(orbit.target).setLength(distance.current));
    state.camera.position.lerp(desired, smoothing);
    orbit.update();

    if (orbit.target.distanceTo(goal.current) < 0.4) active.current = false;
  });

  const still = usePrefersReducedMotion();

  return (
    <OrbitControls
      ref={controls}
      target={center}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      enableZoom={!showcase}
      enablePan={!showcase}
      autoRotate={showcase && !still}
      autoRotateSpeed={0.45}
    />
  );
}

/**
 * Shift the projection so the orbit centre sits in the middle of the area the panels
 * don't cover, not the middle of the whole canvas (which is behind the panels). Picking
 * uses the same projection, so clicks still hit.
 */
function ViewOffset({ occludedRight }: { occludedRight: number }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const { width, height } = useThree((state) => state.size);

  useEffect(() => {
    if (occludedRight > 0 && occludedRight < width) {
      camera.setViewOffset(width, height, occludedRight / 2, 0, width, height);
    } else {
      camera.clearViewOffset();
    }
    return () => camera.clearViewOffset();
  }, [camera, width, height, occludedRight]);

  return null;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function GraphScene(
  props: SceneProps & {
    focusIndex?: number;
    mode?: SceneMode;
    /**
     * How many pixels on the right are covered by panels, so we centre the view next to
     * them.
     */
    occludedRight?: number;
    /** Folder bubbles, in the folders view. */
    clusterView?: ClusterView;
    focusCluster?: Cluster;
  },
) {
  const { layout, mode = "tool", occludedRight = 0 } = props;
  const showcase = mode === "showcase";
  // The explorer frames the important files; the showcase frames the whole graph, since
  // it's there to show the shape of a codebase. The showcase sits next to the headline
  // and nobody zooms it, so it draws nodes bigger: on screen a node's size is its scale
  // over the camera distance factor, 2.8 / 1.4 here vs 1 / 1.6 in the explorer.
  const folders = props.clusterView?.clusters;
  const frame = useMemo<Frame>(
    () =>
      showcase
        ? layout.overview
        : folders
          ? clusterFrame(folders, layout.radius)
          : { center: layout.center, radius: layout.radius },
    [showcase, folders, layout],
  );
  // Everything gets sized against one frame. In the folders view that's the folders'
  // frame, so an open folder's files come out a bit smaller than a bubble instead of
  // specks next to giant spheres.
  const framing = frame.radius;
  const distance = frame.radius * (showcase ? 1.4 : 1.6);
  const { center } = frame;
  const [labels] = useState(() => new LabelRegistry());

  // The far plane has to reach past the furthest node as seen from the camera, not just
  // past the framing radius. A hardcoded 20,000 once clipped an entire 18,851-node scene
  // out of existence; working it out means it grows with the graph. `extent` is measured
  // from the explorer's centre, and the gap between the two centres covers the showcase,
  // which orbits the other one.
  const gap = Math.hypot(
    center.x - layout.center.x,
    center.y - layout.center.y,
    center.z - layout.center.z,
  );
  const far = Math.max((distance + layout.extent + gap) * 1.5, 2_000);
  // Keep some depth precision when far is large, without clipping a focused node.
  const near = Math.min(1, Math.max(0.1, framing / 5_000));

  return (
    <Canvas
      camera={{
        position: [center.x + distance * 0.6, center.y + distance * 0.45, center.z + distance * 0.8],
        fov: 55,
        near,
        far,
      }}
      dpr={[1, 2]}
      // Clicking empty space clears the selection, which is what you'd expect.
      onPointerMissed={() => props.onSelect(-1)}
      // Screen readers can't read the scene, so it says what it is. The node panel and
      // the Ask panel's sources are the accessible way to the same info.
      role="img"
      aria-label={`3D dependency graph of ${layout.nodes.length} files, coloured by importance`}
    >
      <color attach="background" args={[FIELD]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[1, 1, 1]} intensity={1.1} />
      <directionalLight position={[-1, -0.5, -1]} intensity={0.35} />

      <Edges layout={layout} threshold={props.threshold} opacity={showcase ? 0.75 : 0.5} hidden={props.hidden} />
      <Nodes {...props} nodeScale={showcase ? 2.8 : 1} framing={framing} />
      {!showcase && (
        <Labels
          layout={layout}
          threshold={props.threshold}
          selectedIndex={props.selectedIndex}
          framing={framing}
          hidden={props.hidden}
          registry={labels}
        />
      )}
      {props.clusterView && <ClusterLayer view={props.clusterView} framing={frame.radius} registry={labels} />}
      {!showcase && <LabelCollisions registry={labels} />}

      <CameraFocus
        layout={layout}
        focusIndex={props.focusIndex}
        focusCluster={props.focusCluster}
        radius={framing}
        mode={mode}
        frame={frame}
      />
      <ViewOffset occludedRight={occludedRight} />
    </Canvas>
  );
}
