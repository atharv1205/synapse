import type { FileNode, RepoGraph } from "@synapse/core";
import type { SimulationInput } from "./simulate";

/** A file node with a resolved 3D position. */
export interface PositionedNode {
  node: FileNode;
  /** Index into the graph's node array; also the instance index in the scene. */
  index: number;
  x: number;
  y: number;
  z: number;
  /** Directory the file lives in, used for grouping and colouring. */
  directory: string;
}

export interface LayoutEdge {
  from: number;
  to: number;
  weight: number;
}

export interface Layout {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  /** Distinct directories, sorted, so colour assignment is stable across reloads. */
  directories: string[];
  /**
   * The radius the camera frames against: a percentile of node distance from the
   * origin, not the maximum.
   *
   * The maximum is an outlier statistic. On an 18,851-node graph a handful of stragglers
   * pushed it to 25,282 while the median node sat at 1,924, so framing against it put
   * the camera 40,451 units out — past the far plane, with every node subtending about
   * an arcminute. A percentile tracks where the graph actually is.
   */
  radius: number;
  /**
   * Distance to the single furthest node. Only used to size the far plane, so that the
   * outliers the framing radius deliberately ignores still are not clipped away.
   */
  extent: number;
}

/**
 * Which percentile of node distance the camera frames against.
 *
 * Measured on home-assistant/core (18,851 nodes), the distance distribution has a cliff:
 * p50 1924, p90 2340, p95 12581, max 25282. Ninety percent of the graph sits inside
 * 2340 units and the rest is flung out behind it, so p95 lands on the far side of the
 * tail and frames almost as badly as the max did — a top node subtends 2.4 arcminutes
 * there (about half a pixel) versus 12.9 at p90. Framing at p90 keeps nine nodes in ten
 * on screen and the rest a scroll away.
 */
const FRAMING_PERCENTILE = 0.9;

export function directoryOf(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

/**
 * Flattens a graph into what the force simulation needs, plus the resolved edge list
 * the scene draws. Cheap — a pass over the edges — so it stays on the main thread.
 *
 * Importance shapes the layout through link distance: an important file sits closer to
 * what imports it, so clusters form around the files that matter.
 */
export function simulationInput(graph: RepoGraph): { input: SimulationInput; edges: LayoutEdge[] } {
  const indexById = new Map<string, number>();
  graph.nodes.forEach((node, index) => indexById.set(node.id, index));

  const edges: LayoutEdge[] = [];
  for (const edge of graph.edges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to, weight: edge.weight });
  }

  const linkSource = new Int32Array(edges.length);
  const linkTarget = new Int32Array(edges.length);
  const linkDistance = new Float64Array(edges.length);
  edges.forEach((edge, i) => {
    const importance = graph.nodes[edge.to]?.importance ?? 0;
    linkSource[i] = edge.from;
    linkTarget[i] = edge.to;
    linkDistance[i] = 40 + (1 - importance) * 60;
  });

  return {
    input: { nodeCount: graph.nodes.length, linkSource, linkTarget, linkDistance },
    edges,
  };
}

/**
 * Builds the scene's layout from settled simulation positions: attaches each position
 * to its file, and works out the directory palette and the camera's framing radius.
 */
export function assembleLayout(
  graph: RepoGraph,
  edges: LayoutEdge[],
  positions: Float64Array,
): Layout {
  const nodes: PositionedNode[] = graph.nodes.map((node, index) => ({
    node,
    index,
    x: positions[index * 3] ?? 0,
    y: positions[index * 3 + 1] ?? 0,
    z: positions[index * 3 + 2] ?? 0,
    directory: directoryOf(node.path),
  }));

  const directories = [...new Set(nodes.map((n) => n.directory))].sort();

  const distances = nodes.map((n) => Math.hypot(n.x, n.y, n.z)).sort((a, b) => a - b);
  const at = (fraction: number) =>
    distances.length === 0
      ? 0
      : (distances[Math.min(distances.length - 1, Math.floor(distances.length * fraction))] ?? 0);

  // `|| 100` covers a single-node graph, where every distance is zero.
  const radius = at(FRAMING_PERCENTILE) || 100;
  const extent = distances[distances.length - 1] ?? radius;

  return { nodes, edges, directories, radius, extent: Math.max(extent, radius) };
}
