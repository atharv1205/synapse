import { simulate, type SimulationInput } from "./simulate";

/** Main thread → worker: lay this graph out. */
export type LayoutRequest = SimulationInput;

/** Worker → main thread. */
export type LayoutMessage =
  | { type: "progress"; tick: number; total: number }
  | { type: "done"; positions: Float64Array }
  | { type: "error"; message: string };

/**
 * How often progress is reported, at most.
 *
 * Also the delay before the first report, which is what keeps small graphs from ever
 * showing a progress screen: a layout that finishes inside this window posts nothing
 * but its result, and the app goes straight from "Loading graph" to the scene.
 */
const PROGRESS_INTERVAL_MS = 150;

// The web tsconfig types the global scope as a Window, whose postMessage takes a
// target origin. This is the dedicated-worker shape actually in play here.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutMessage, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  try {
    const started = performance.now();
    let reported = started;

    const positions = simulate(event.data, (tick, total) => {
      const now = performance.now();
      if (now - reported < PROGRESS_INTERVAL_MS) return;
      reported = now;
      scope.postMessage({ type: "progress", tick, total });
    });

    scope.postMessage({ type: "done", positions }, [positions.buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
