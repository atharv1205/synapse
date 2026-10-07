import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimNode } from "d3-force-3d";

/**
 * Everything the force simulation needs and nothing more.
 *
 * It's flat typed arrays on purpose, not the graph itself. This gets posted to the layout
 * worker, and structured-cloning an 18,851-node RepoGraph (paths, summaries, function
 * lists) would cost the main thread more than the layout we're trying to move off it.
 * Typed arrays transfer without copying.
 */
export interface SimulationInput {
  nodeCount: number;
  /** Per link: index of the importing node. */
  linkSource: Int32Array;
  /** Per link: index of the imported node. */
  linkTarget: Int32Array;
  /** Per link: the distance the link force pulls the two ends towards. */
  linkDistance: Float64Array;
}

interface WorkingNode extends SimNode {
  index: number;
}

/** A link the way d3 wants it: ends by node index, with the target distance baked in. */
interface SimulationLink {
  source: number;
  target: number;
  distance: number;
}

/**
 * How many simulation ticks to run before drawing.
 *
 * We run the whole simulation before drawing anything instead of animating it: a graph
 * that's still settling is harder to read than a settled one, and redrawing tens of
 * thousands of instances every tick costs more than the tick itself. Bigger graphs get
 * fewer ticks so the wait doesn't blow up.
 */
export function tickCount(nodeCount: number): number {
  if (nodeCount <= 200) return 400;
  if (nodeCount <= 1000) return 250;
  return 150;
}

/** Fewer nodes means more repulsion, so small graphs don't bunch up. */
function repulsion(nodeCount: number): number {
  if (nodeCount <= 50) return -220;
  if (nodeCount <= 300) return -140;
  return -80;
}

/**
 * Run the force simulation to the end and return the settled positions as a flat
 * `[x0, y0, z0, x1, y1, z1, …]` array, in the same order as the graph's nodes.
 *
 * Pure function, no DOM, so it behaves the same in the worker as anywhere else. `onTick`
 * runs after every tick; the worker uses it for progress, and it's up to the caller to
 * throttle anything expensive.
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
    // Seed deterministically so the same graph always gets the same layout.
    x: Math.cos(index * 2.399) * (10 + index),
    y: Math.sin(index * 2.399) * (10 + index),
    z: ((index % 17) - 8) * 6,
  }));

  // Ends are node indices, which forceLink's default id accessor understands. The target
  // distance is worked out up front instead of inside the force, because by tick time d3
  // has swapped the ends for node objects.
  const links: SimulationLink[] = Array.from({ length: input.linkSource.length }, (_, i) => ({
    source: input.linkSource[i]!,
    target: input.linkTarget[i]!,
    distance: input.linkDistance[i]!,
  }));

  const simulation = forceSimulation<WorkingNode>(working, 3)
    // forceSimulation starts its own timer. We drive the ticks by hand instead.
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
