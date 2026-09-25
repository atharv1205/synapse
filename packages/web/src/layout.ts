import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimNode } from "d3-force-3d";
import type { FileNode, RepoGraph } from "@synapse/core";

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

interface WorkingNode extends SimNode {
  id: string;
  index: number;
}

/** A link as d3 consumes it: endpoints by node id, with its target distance baked in. */
interface SimulationLink {
  source: string;
  target: string;
  distance: number;
}

/**
 * How many simulation ticks to run before rendering.
 *
 * The simulation runs to completion up front rather than animating frame by frame.
 * d3-force-3d is O(n log n) per tick and runs on the main thread, so animating it on a
 * few thousand nodes janks badly, and a settling graph is harder to read than a settled
 * one. Fewer ticks for larger graphs keeps the wait bounded.
 */
function tickCount(nodeCount: number): number {
  if (nodeCount <= 200) return 400;
  if (nodeCount <= 1000) return 250;
  return 150;
}

/** Nodes repel more when there are fewer of them, so small graphs do not bunch up. */
function repulsion(nodeCount: number): number {
  if (nodeCount <= 50) return -220;
  if (nodeCount <= 300) return -140;
  return -80;
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
 * Runs the force layout for a graph and returns settled positions.
 *
 * Importance drives two things here: heavier nodes get a stronger pull toward the
 * centre, so the files that matter end up in the middle of the scene where they are
 * easiest to see, and edge distance shortens between important nodes so clusters form
 * around them.
 */
export function computeLayout(graph: RepoGraph): Layout {
  const indexById = new Map<string, number>();
  graph.nodes.forEach((node, index) => indexById.set(node.id, index));

  const working: WorkingNode[] = graph.nodes.map((node, index) => ({
    id: node.id,
    index,
    // Seed deterministically so the same graph always lays out the same way.
    x: Math.cos(index * 2.399) * (10 + index),
    y: Math.sin(index * 2.399) * (10 + index),
    z: ((index % 17) - 8) * 6,
  }));

  // d3-force resolves link endpoints by looking them up in a Map keyed by the `id`
  // accessor, so the endpoints and the accessor must agree on type. Using the node's
  // own id (its path) keeps that unambiguous. The target distance is precomputed here
  // rather than read inside the force, because by tick time d3 has replaced the
  // endpoints with node objects and the accessor would have to handle both shapes.
  const links: SimulationLink[] = [];
  const edges: LayoutEdge[] = [];

  for (const edge of graph.edges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined) continue;

    const importance = graph.nodes[to]?.importance ?? 0;
    links.push({
      source: edge.from,
      target: edge.to,
      // Important files sit closer to what imports them, tightening their clusters.
      distance: 40 + (1 - importance) * 60,
    });
    edges.push({ from, to, weight: edge.weight });
  }

  const count = working.length;

  if (count > 0) {
    const simulation = forceSimulation<WorkingNode>(working, 3)
      .force(
        "charge",
        forceManyBody()
          .strength(repulsion(count))
          .distanceMax(600),
      )
      .force(
        "link",
        forceLink<WorkingNode, SimulationLink>(links)
          .id((node) => node.id)
          .distance((link) => link.distance)
          .strength(0.4),
      )
      .force("center", forceCenter(0, 0, 0).strength(0.05))
      .velocityDecay(0.35)
      .alphaDecay(0)
      .alphaMin(0);

    simulation.tick(tickCount(count));
    simulation.stop();
  }

  const nodes: PositionedNode[] = working.map((w) => {
    const node = graph.nodes[w.index]!;
    return {
      node,
      index: w.index,
      x: w.x ?? 0,
      y: w.y ?? 0,
      z: w.z ?? 0,
      directory: directoryOf(node.path),
    };
  });

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
