import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimNode } from "d3-force-3d";

/**
 * Everything the force simulation needs, and nothing else.
 *
 * This is deliberately flat typed arrays rather than the graph itself: it is what gets
 * posted to the layout worker, and structured-cloning an 18,851-node RepoGraph — paths,
 * summaries, function lists — would cost the main thread more than the layout it is
 * trying to offload. Typed arrays transfer without a copy.
 */
export interface SimulationInput {
  nodeCount: number;
  /** Per link, the index of the importing node. */
  linkSource: Int32Array;
  /** Per link, the index of the imported node. */
  linkTarget: Int32Array;
  /** Per link, the distance the link force pulls its endpoints toward. */
  linkDistance: Float64Array;
}

interface WorkingNode extends SimNode {
  index: number;
}

/** A link as d3 consumes it: endpoints by node index, with its target distance baked in. */
interface SimulationLink {
  source: number;
  target: number;
  distance: number;
}

/**
 * How many simulation ticks to run before rendering.
 *
 * The simulation runs to completion before anything is drawn rather than animating
 * frame by frame: a settling graph is harder to read than a settled one, and redrawing
 * tens of thousands of instances every tick costs more than the tick. Fewer ticks for
 * larger graphs keeps the wait bounded.
 */
export function tickCount(nodeCount: number): number {
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
 * Runs the force simulation to completion and returns settled positions as a flat
 * `[x0, y0, z0, x1, y1, z1, …]` array, indexed like the graph's nodes.
 *
 * A pure function of its input with no DOM dependency, so it runs the same in the
 * layout worker as anywhere else. `onTick` is called after every tick; it is how the
 * worker reports progress, and it is the caller's job to throttle anything expensive.
 */
export function simulate(
  input: SimulationInput,
  onTick?: (tick: number, total: number) => void,
): Float64Array {
  const count = input.nodeCount;
  const positions = new Float64Array(count * 3);
  if (count === 0) return positions;

  const working: WorkingNode[] = Array.from({ length: count }, (_, index) => ({
    index,
    // Seed deterministically so the same graph always lays out the same way.
    x: Math.cos(index * 2.399) * (10 + index),
    y: Math.sin(index * 2.399) * (10 + index),
    z: ((index % 17) - 8) * 6,
  }));

  // Endpoints are node indices, which is what forceLink's default id accessor resolves
  // against. The target distance is precomputed rather than derived inside the force,
  // because by tick time d3 has replaced the endpoints with node objects.
  const links: SimulationLink[] = Array.from({ length: input.linkSource.length }, (_, i) => ({
    source: input.linkSource[i]!,
    target: input.linkTarget[i]!,
    distance: input.linkDistance[i]!,
  }));

  const simulation = forceSimulation<WorkingNode>(working, 3)
    // forceSimulation starts its own timer; this drives ticks by hand instead.
    .stop()
    .force(
      "charge",
      forceManyBody()
        .strength(repulsion(count))
        .distanceMax(600),
    )
    .force(
      "link",
      forceLink<WorkingNode, SimulationLink>(links)
        .distance((link) => link.distance)
        .strength(0.4),
    )
    .force("center", forceCenter(0, 0, 0).strength(0.05))
    .velocityDecay(0.35)
    .alphaDecay(0)
    .alphaMin(0);

  const total = tickCount(count);
  for (let tick = 1; tick <= total; tick++) {
    simulation.tick();
    onTick?.(tick, total);
  }

  working.forEach((node, i) => {
    positions[i * 3] = node.x ?? 0;
    positions[i * 3 + 1] = node.y ?? 0;
    positions[i * 3 + 2] = node.z ?? 0;
  });
  return positions;
}
