import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from "react";
import * as THREE from "three";
import type { Cluster, ClusterEdge } from "../clusters";
import type { Layout, PositionedNode } from "../layout";

/** Distinct hues for directory colouring, spaced so neighbours stay distinguishable. */
const DIRECTORY_HUES = [0.53, 0.09, 0.35, 0.78, 0.14, 0.47, 0.93, 0.62, 0.24, 0.86];

/** The darkfield the whole UI sits on; matches `--field` in tokens.css. */
const FIELD = "#0b1020";

/**
 * The importance ramp, as fluorescent stains: dim cyan for the long tail, then cyan,
 * green and amber for the files that matter. Mirrors `--importance-ramp` in tokens.css,
 * which the toolbar legend draws, so the legend and the nodes agree.
 */
const RAMP = [
  { at: 0, color: new THREE.Color("#2b6f88") },
  { at: 0.35, color: new THREE.Color("#4fd1e8") },
  { at: 0.65, color: new THREE.Color("#7be08a") },
  { at: 1, color: new THREE.Color("#f2b84b") },
];

export type ColorMode = "importance" | "directory";

/**
 * "tool" is the explorer at /graph. "showcase" is the landing hero: it turns slowly on
 * its own, cannot be zoomed (so the page still scrolls under the pointer), and does not
 * select nodes.
 */
export type SceneMode = "tool" | "showcase";

export interface SceneProps {
  layout: Layout;
  /** Nodes with importance below this are dimmed and shrunk. */
  threshold: number;
  colorMode: ColorMode;
  selectedIndex?: number;
  /** Indices highlighted because a Q&A answer cited them. */
  citedIndices: number[];
  onSelect(index: number): void;
  /**
   * Per node index, 1 for files folded into a collapsed folder bubble. Hidden files are
   * drawn at zero size, so they cannot be clicked, and their edges and labels are skipped.
   */
  hidden?: Uint8Array;
}

/** The folder bubbles drawn in place of collapsed folders' files. */
export interface ClusterView {
  clusters: Cluster[];
  edges: ClusterEdge[];
  /** Per cluster index, 1 while it is collapsed into a bubble. */
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
 * Importance is PageRank-shaped, with nearly every file near zero, so the ramp reads
 * sqrt(importance): the same curve node size uses, which spreads the long tail enough
 * for the middle stains to show up at all.
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
 * Node radius in world units, as a fraction of the framing radius rather than an
 * absolute size.
 *
 * Fixed world-unit sizes only look right at one scale. At 1.6 + sqrt(importance) * 5.4
 * a typical node was a comfortable 7px on a 26-file graph and 0.40px on an 18,851-file
 * one — present, unclipped, and far too small to see, which is why that scene still read
 * as empty after the clipping fix. Scaling with the framing radius keeps apparent size
 * constant: roughly 3.5px for a typical node and 14px for the most important one, at any
 * graph size.
 */
function radiusFor(positioned: PositionedNode, framingRadius: number): number {
  const t = Math.min(1, Math.max(0, positioned.node.importance));
  return framingRadius * (0.006 + 0.018 * Math.sqrt(t));
}

/**
 * Every node is one instance of a single mesh, so the whole graph is one draw call
 * regardless of size. Thousands of individual meshes would each cost a draw call and
 * tank the framerate long before the node count itself became a problem — which is why
 * the importance threshold fades and shrinks nodes rather than unmounting them.
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

  // A unit sphere; every node's real radius is folded into its instance matrix.
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

      // Below the threshold a node stays present but small, so it remains a landmark
      // without competing for attention. Selected and cited nodes always show at size.
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
  /** Shown even when it overlaps, e.g. the selected item. */
  always?: boolean;
}

/**
 * Every label on the map, from every layer, so overlaps are judged across all of them:
 * an expanded folder's file names and the folder bubbles' names must not pile up on
 * each other any more than within their own set. Groups are checked in the order they
 * are listed in `GROUP_ORDER`, and anything marked `always` goes first.
 */
class LabelRegistry {
  readonly groups = new Map<string, Anchor[]>();
  readonly elements = new Map<string, HTMLElement>();
}

/** Files before folders: a folder was expanded precisely to read its files' names. */
const GROUP_ORDER = ["files", "folders"];

/**
 * Registers one layer's labels and returns a ref factory for their elements. Keys are
 * namespaced by group, so a file and a folder never collide.
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
 * Hides any label that would overlap one placed before it. Checked a few times a second
 * against where the labels sit on screen, so a label reappears as soon as rotating the
 * graph gives it room.
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
    // Selected items first, whatever their layer, so they always win.
    ordered.sort((a, b) => Number(Boolean(b.anchor.always)) - Number(Boolean(a.anchor.always)));

    const placed: Array<[number, number, number, number]> = [];
    for (const { group, anchor } of ordered) {
      const element = registry.elements.get(`${group}:${anchor.key}`);
      if (!element) continue;
      scratch.set(anchor.x, anchor.y, anchor.z).project(camera);
      const behind = scratch.z > 1;
      // Where the label really is, which a hidden label still has. Re-deriving it from
      // the projection drifted from drei's placement under the panel's view offset, and
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

/** How many of the most important prominent files get a name on the map. */
const LABEL_COUNT = 12;

/**
 * The name a label shows: the file name, or `folder/file` for names that say nothing on
 * their own, like `index.ts` or `__init__.py`, of which a repository has dozens.
 */
export function labelFor(filePath: string): string {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1] ?? filePath;
  const generic = /^(index\.[cm]?[jt]sx?|__init__\.py|mod\.rs|main\.(py|go))$/.test(name);
  return generic && parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name;
}

/**
 * Names on the map for the files that matter most, so the important ones can be found by
 * eye without clicking around. Only the top few prominent files and the selected one are
 * labelled; naming every node would bury the graph.
 *
 * These are DOM labels (drei's Html), not 3D text: they stay crisp at any zoom, and drei's
 * 3D text builds a worker from a blob: URL, which the server's Content-Security-Policy
 * refuses. They sit below the panels, which carry z-index 2.
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
    // The selected file goes first, so it wins every overlap below.
    if (selected && !hidden?.[selected.index]) return [selected, ...top.filter((n) => n !== selected)];
    return top;
  }, [layout, threshold, selectedIndex, hidden]);

  // Two labelled files with the same name (src/flask/app.py, src/flask/sansio/app.py)
  // would be indistinguishable, so clashing names get their folder.
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
        // Lift the label just clear of its sphere, whose radius scales with the frame.
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
 * All edges live in one LineSegments buffer — again one draw call.
 *
 * Direction is shown by a per-vertex colour gradient: each line starts dim at the
 * importer and brightens toward the file being imported. At this density arrowheads
 * would be unreadable clutter, but a gradient reads at a glance even when zoomed out.
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
 * What the folders view frames: every folder bubble, rather than the important files the
 * files view frames. Test and example folders often sit well away from the core, and a
 * folder view that cut them off would hide most bubbles. The centre is the middle of the
 * bubbles' bounding box, not their file-weighted centroid: on home-assistant two giant
 * overflow bubbles pulled a weighted centre to one end, pushing the rest off-screen.
 */
function clusterFrame(clusters: Cluster[], floor: number): Frame {
  if (clusters.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: floor };
  const mid = (axis: "x" | "y" | "z") => {
    const values = clusters.map((c) => c[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  const center = { x: mid("x"), y: mid("y"), z: mid("z") };
  const furthest = Math.max(...clusters.map((c) => Math.hypot(c.x - center.x, c.y - center.y, c.z - center.z)));
  // The camera sits 1.6 radii out, which with a 55° field of view shows about 0.8 radii
  // above and below the centre, and less when the error banner shortens the canvas.
  return { center, radius: Math.max(furthest * 1.4, floor) };
}

/** How many folder bubbles get a name; the largest first, plus the selected one. */
const CLUSTER_LABEL_COUNT = 15;

/**
 * Folders drawn as bubbles in place of their files: one instanced mesh for the bubbles
 * and one line buffer for the imports between folders, so even home-assistant's 18,932
 * files become a few dozen shapes and a few hundred lines. A bubble's size follows its
 * file count and its colour its most important file.
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
    // radiusOf depends only on framing and largest, both listed.
  }, [view, framing, largest]);

  // Imports between two collapsed folders, brighter for more of them.
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
    // radiusOf depends only on framing and largest.
    [labelled, view.selected, framing, largest],
  );
  const register = useLabelGroup(registry, "folders", anchors);

  // Bubbles overlap where the layout packs folders together, and on home-assistant two
  // giant ones sit over the core. Once a folder is open its files must show through them,
  // so the rest turn to glass.
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
 * Eases the orbit target and the camera onto a node when one is focused, instead of
 * cutting, so it stays obvious where the view travelled from.
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
  /** A folder to fly to, by object so focusing the same one twice still moves. */
  focusCluster?: Cluster;
  radius: number;
  mode: SceneMode;
  /** What the view frames; switching between files and folders flies to the new one. */
  frame: Frame;
}) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const goal = useRef(new THREE.Vector3());
  const distance = useRef(radius);
  const active = useRef(false);
  // Read, not depended on, by the focus effects below. Switching between the files and
  // folders views changes the radius; were it a dependency, the focused file would be
  // flown back to and the new view's frame overridden, leaving the camera inside the
  // folder bubbles.
  const radiusRef = useRef(radius);
  radiusRef.current = radius;

  // Orbit around the frame's centre (the important files, or the folders), not the
  // origin. Fixed at mount: later frames are flown to below rather than jumped to, and a
  // target prop that changed on every render would yank the camera off a node.
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

    // Frame the node among its neighbours rather than filling the viewport with it. The
    // floor is half the framing radius: a fixed 45 units once put the camera inside
    // pallets/flask's cluster, where the neighbouring spheres filled the whole screen.
    const radius = radiusRef.current;
    const own = radiusFor(positioned, radius) * 14;
    distance.current = Math.min(Math.max(own, radius * 0.5), radius * 1.4);
    active.current = true;
  }, [focusIndex, layout]);

  useEffect(() => {
    if (!focusCluster) return;
    goal.current.set(focusCluster.x, focusCluster.y, focusCluster.z);
    // Frame the folder's own files: far enough to take in their spread, near enough that
    // they read at the size they have in the files view.
    const radius = radiusRef.current;
    distance.current = Math.min(Math.max(focusCluster.spread * 2.4, radius * 0.35), radius * 1.4);
    active.current = true;
  }, [focusCluster]);

  useFrame((state, delta) => {
    const orbit = controls.current;
    if (!orbit || !active.current) return;

    const smoothing = 1 - Math.exp(-6 * delta);
    orbit.target.lerp(goal.current, smoothing);

    // Move along the current viewing direction, so focusing never spins the scene.
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
 * Shifts the projection so the orbit centre sits in the middle of the part of the canvas
 * the panels leave uncovered, rather than the middle of the whole canvas, which is behind
 * the panels' left edge. Picking uses the same projection, so clicks still land.
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
    /** Pixels of the canvas's right edge covered by panels, to centre the view beside. */
    occludedRight?: number;
    /** Folder bubbles, in the folders view. */
    clusterView?: ClusterView;
    focusCluster?: Cluster;
  },
) {
  const { layout, mode = "tool", occludedRight = 0 } = props;
  const showcase = mode === "showcase";
  // The explorer frames the important files; the showcase frames the whole graph, since
  // its job is to show the shape of a codebase. The showcase sits beside the headline and
  // nobody zooms it, so it draws nodes heavier: on screen a node's size goes as its scale
  // over the camera's distance factor, 2.8 / 1.4 here against 1 / 1.6 in the explorer.
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
  // Everything on screen is sized against one frame. In the folders view that is the
  // folders' frame, so an expanded folder's files come out smaller than a bubble rather
  // than as specks beside giant spheres.
  const framing = frame.radius;
  const distance = frame.radius * (showcase ? 1.4 : 1.6);
  const { center } = frame;
  const [labels] = useState(() => new LabelRegistry());

  // The far plane has to reach past the furthest node as seen from the camera, not just
  // past the framing radius. A hardcoded 20,000 clipped an entire 18,851-node scene out
  // of existence; deriving it means the clip distance grows with the graph.
  // `extent` is measured from the explorer's centre; the gap between the two centres
  // covers the showcase, which orbits the other one.
  const gap = Math.hypot(
    center.x - layout.center.x,
    center.y - layout.center.y,
    center.z - layout.center.z,
  );
  const far = Math.max((distance + layout.extent + gap) * 1.5, 2_000);
  // Keep some depth-buffer precision at large far values without clipping a focused node.
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
      // Clicking empty space clears the selection, which is what the gesture implies.
      onPointerMissed={() => props.onSelect(-1)}
      // The scene cannot be read by a screen reader, so it says what it is; the node
      // panel and the Ask panel's sources are the accessible way into the same data.
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
