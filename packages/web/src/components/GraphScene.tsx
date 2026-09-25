import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type ElementRef } from "react";
import * as THREE from "three";
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

  // Importance is PageRank-shaped, with nearly every file near zero, so the ramp reads
  // sqrt(importance): the same curve node size uses, which spreads the long tail enough
  // for the middle stains to show up at all.
  const t = Math.sqrt(Math.min(1, Math.max(0, positioned.node.importance)));
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
}: SceneProps & { nodeScale: number }) {
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
      const scale = radiusFor(positioned, layout.radius) * nodeScale * emphasis * dimming;

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
  }, [layout, threshold, colorMode, selectedIndex, cited, scratch, nodeScale]);

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
}: {
  layout: Layout;
  threshold: number;
  opacity: number;
}) {
  const geometry = useMemo(() => {
    const visible = layout.edges.filter((edge) => {
      const from = layout.nodes[edge.from];
      const to = layout.nodes[edge.to];
      return (
        from !== undefined &&
        to !== undefined &&
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
  }, [layout, threshold]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={opacity} />
    </lineSegments>
  );
}

/**
 * Eases the orbit target and the camera onto a node when one is focused, instead of
 * cutting, so it stays obvious where the view travelled from.
 */
function CameraFocus({
  layout,
  focusIndex,
  radius,
  mode,
}: {
  layout: Layout;
  focusIndex?: number;
  radius: number;
  mode: SceneMode;
}) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const goal = useRef(new THREE.Vector3());
  const distance = useRef(radius);
  const active = useRef(false);

  useEffect(() => {
    if (focusIndex === undefined) return;
    const positioned = layout.nodes.find((n) => n.index === focusIndex);
    if (!positioned) return;

    goal.current.set(positioned.x, positioned.y, positioned.z);

    // Frame the node against its neighbours rather than filling the viewport with it.
    // Keying off the node's own radius keeps that framing consistent whether the graph
    // is 20 files across or 2000; the graph radius only supplies an upper bound so the
    // camera never pulls back beyond the whole scene.
    const own = radiusFor(positioned, radius) * 14;
    distance.current = Math.min(Math.max(own, 45), radius * 1.4);
    active.current = true;
  }, [focusIndex, layout, radius]);

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

  const showcase = mode === "showcase";
  const still = usePrefersReducedMotion();

  return (
    <OrbitControls
      ref={controls}
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

export function GraphScene(props: SceneProps & { focusIndex?: number; mode?: SceneMode }) {
  const { layout, mode = "tool" } = props;
  // The showcase sits beside the headline in a fraction of the window and nobody zooms
  // it, so it frames tighter and draws nodes and edges heavier than the explorer does,
  // where the same sizes would read as specks.
  const showcase = mode === "showcase";
  const distance = layout.radius * (showcase ? 0.95 : 1.6);

  // The far plane has to reach past the furthest node as seen from the camera, not just
  // past the framing radius. A hardcoded 20,000 clipped an entire 18,851-node scene out
  // of existence; deriving it means the clip distance grows with the graph.
  const far = Math.max((distance + layout.extent) * 1.5, 2_000);
  // Keep some depth-buffer precision at large far values without clipping a focused node.
  const near = Math.min(1, Math.max(0.1, layout.radius / 5_000));

  return (
    <Canvas
      camera={{
        position: [distance * 0.6, distance * 0.45, distance * 0.8],
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

      <Edges layout={layout} threshold={props.threshold} opacity={showcase ? 0.75 : 0.5} />
      <Nodes {...props} nodeScale={showcase ? 1.9 : 1} />

      <CameraFocus
        layout={layout}
        focusIndex={props.focusIndex}
        radius={layout.radius}
        mode={mode}
      />
    </Canvas>
  );
}
