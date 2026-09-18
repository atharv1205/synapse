import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ElementRef } from "react";
import * as THREE from "three";
import type { Layout, PositionedNode } from "../layout";

/** Distinct hues for directory colouring, spaced so neighbours stay distinguishable. */
const DIRECTORY_HUES = [0.58, 0.08, 0.33, 0.78, 0.13, 0.47, 0.92, 0.65, 0.22, 0.86];

export type ColorMode = "importance" | "directory";

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
    return target.setHSL(hue, 0.55, 0.58);
  }

  // Importance ramps cool-to-warm: low is a muted blue, high is a bright amber.
  const t = Math.min(1, Math.max(0, positioned.node.importance));
  return target.setHSL(0.62 - t * 0.52, 0.45 + t * 0.45, 0.35 + t * 0.3);
}

/** Radius in world units. Importance drives size, with a floor so nothing vanishes. */
function radiusFor(positioned: PositionedNode): number {
  return 1.6 + Math.sqrt(Math.min(1, Math.max(0, positioned.node.importance))) * 5.4;
}

/**
 * Every node is one instance of a single mesh, so the whole graph is one draw call
 * regardless of size. Thousands of individual meshes would each cost a draw call and
 * tank the framerate long before the node count itself became a problem — which is why
 * the importance threshold fades and shrinks nodes rather than unmounting them.
 */
function Nodes({ layout, threshold, colorMode, selectedIndex, citedIndices, onSelect }: SceneProps) {
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
      const scale = radiusFor(positioned) * emphasis * dimming;

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
  }, [layout, threshold, colorMode, selectedIndex, cited, scratch]);

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
function Edges({ layout, threshold }: { layout: Layout; threshold: number }) {
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

    const tail = new THREE.Color("#2f3b52");
    const head = new THREE.Color("#7fa8d8");

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
      <lineBasicMaterial vertexColors transparent opacity={0.5} />
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
}: {
  layout: Layout;
  focusIndex?: number;
  radius: number;
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
    const own = radiusFor(positioned) * 14;
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

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} />;
}

export function GraphScene(props: SceneProps & { focusIndex?: number }) {
  const { layout } = props;
  const distance = layout.radius * 1.6;

  return (
    <Canvas
      camera={{ position: [distance * 0.6, distance * 0.45, distance * 0.8], fov: 55, far: 20000 }}
      dpr={[1, 2]}
      // Clicking empty space clears the selection, which is what the gesture implies.
      onPointerMissed={() => props.onSelect(-1)}
    >
      <color attach="background" args={["#0b0f17"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[1, 1, 1]} intensity={1.1} />
      <directionalLight position={[-1, -0.5, -1]} intensity={0.35} />

      <Edges layout={layout} threshold={props.threshold} />
      <Nodes {...props} />

      <CameraFocus layout={layout} focusIndex={props.focusIndex} radius={layout.radius} />
    </Canvas>
  );
}
