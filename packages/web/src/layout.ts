import type { FileNode, RepoGraph } from "@synapse/core";
import type { SimulationInput } from "./simulate";

/** A file node with its 3D position worked out. */
export interface PositionedNode {
  node: FileNode;
  /** Index into the graph's node array. Also the instance index in the scene. */
  index: number;
  x: number;
  y: number;
  z: number;
  /** Folder the file lives in, for grouping and colouring. */
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
  /** Unique folders, sorted, so colours stay the same across reloads. */
  directories: string[];
  /**
   * Where the camera looks: the importance-weighted centre of the most important files.
   *
   * Not the origin. The force layout centres the mass of the whole cloud, and in a real
   * repo most of that mass is low-importance stuff like tests, examples and docs. The
   * files that matter end up off to one side. On pallets/flask the 17 most important
   * files sat 1,070 units from the origin in a cluster only 161 across; on
   * home-assistant/core the top 300 sat 2,457 units out, 517 across.
   */
  center: { x: number; y: number; z: number };
  /**
   * The radius the camera frames: the 90th percentile of the important files' distance
   * from `center`. Node sizes and focus distance scale with it, so a node looks the same
   * size on screen whatever the graph size.
   *
   * Percentile and not max, because the max is basically an outlier: framing on it once
   * put the camera for an 18,851-node graph past the far plane.
   */
  radius: number;
  /**
   * A frame for the whole graph instead of just the core: the centre of every file, and
   * the same percentile of distance from it. For views that are about the overall shape,
   * like the landing page hero.
   */
  overview: { center: { x: number; y: number; z: number }; radius: number };
  /**
   * Distance from `center` to the furthest node. Only used to size the far plane, so the
   * outliers the framing ignores still don't get clipped.
   */
  extent: number;
}

/**
 * Which percentile of node distance the camera frames on.
 *
 * On home-assistant/core (18,851 nodes) the distances fall off a cliff: p50 1924, p90
 * 2340, p95 12581, max 25282. 90% of the graph is within 2340 units and the rest is flung
 * way out, so p95 lands past the tail and frames almost as badly as the max. p90 keeps
 * nine in ten nodes on screen and the rest a scroll away.
 */
const FRAMING_PERCENTILE = 0.9;

/**
 * Which files count as "the important ones" for framing: the top fifth by importance, at
 * least 10 and at most 300. 300 is how many files the explorer highlights when it opens a
 * big repo, so the camera frames what's shown.
 */
function focusCount(total: number): number {
  return Math.min(total, 300, Math.max(10, Math.round(total * 0.2)));
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

export function directoryOf(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

/**
 * Flatten a graph into what the force simulation needs, plus the edge list the scene
 * draws. Cheap (one pass over the edges), so it stays on the main thread.
 *
 * Importance affects the layout through link distance: an important file sits closer to
 * whatever imports it, so clusters form around the files that matter.
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
 * Build the scene layout from the settled positions: attach each position to its file,
 * then work out the folder colours and where the camera frames.
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

  const focus = [...nodes]
    .sort((a, b) => b.node.importance - a.node.importance)
    .slice(0, focusCount(nodes.length));

  // Weighted by importance squared, so the camera settles on the few heaviest files. With
  // a linear weight the weaker files in the top fifth pulled the centre off the core; on
  // pallets/flask it ended up about 100 units from typing.py, globals.py and app.py. If
  // every importance is zero (no edges, no history) all weights are equal.
  const mass = (n: PositionedNode) => n.node.importance ** 2;
  const total = focus.reduce((sum, n) => sum + mass(n), 0);
  const weight = (n: PositionedNode) => (total > 0 ? mass(n) / total : 1 / focus.length);
  const center = {
    x: focus.reduce((sum, n) => sum + n.x * weight(n), 0),
    y: focus.reduce((sum, n) => sum + n.y * weight(n), 0),
    z: focus.reduce((sum, n) => sum + n.z * weight(n), 0),
  };

  const distanceFrom =
    (point: { x: number; y: number; z: number }) => (n: PositionedNode) =>
      Math.hypot(n.x - point.x, n.y - point.y, n.z - point.z);
  const sorted = (point: { x: number; y: number; z: number }, set: PositionedNode[]) =>
    set.map(distanceFrom(point)).sort((a, b) => a - b);

  // `|| 100` covers graphs where all the framed files sit on one point, like a single
  // file.
  const radius = percentile(sorted(center, focus), FRAMING_PERCENTILE) || 100;

  const count = nodes.length || 1;
  const middle = {
    x: nodes.reduce((sum, n) => sum + n.x, 0) / count,
    y: nodes.reduce((sum, n) => sum + n.y, 0) / count,
    z: nodes.reduce((sum, n) => sum + n.z, 0) / count,
  };
  const overview = { center: middle, radius: percentile(sorted(middle, nodes), FRAMING_PERCENTILE) || 100 };

  const all = sorted(center, nodes);
  const extent = Math.max(all[all.length - 1] ?? 0, radius);

  return { nodes, edges, directories, center, radius, overview, extent };
}
