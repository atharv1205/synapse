import { useEffect, useState } from "react";
import type { RepoGraph } from "@synapse/core";
import { assembleLayout, simulationInput, type Layout } from "./layout";
import type { LayoutMessage, LayoutRequest } from "./layout.worker";

export interface LayoutProgress {
  tick: number;
  total: number;
}

export interface LayoutState {
  layout?: Layout;
  /** Only set once the layout has run long enough that showing progress is worth it. */
  progress?: LayoutProgress;
  error?: string;
}

/**
 * Lay a graph out in a Web Worker, once per graph.
 *
 * On home-assistant/core (18,851 files) the simulation is 150 ticks at about a quarter
 * second each. Inside a useMemo, like it used to be, that froze the tab for 38 seconds on
 * a blank screen. In a worker the page keeps rendering and can show progress. Only flat
 * typed arrays go back and forth, and both ways they're transferred, not copied.
 */
export function useLayout(graph: RepoGraph | undefined): LayoutState {
  const [state, setState] = useState<LayoutState>({});

  useEffect(() => {
    if (!graph) return;
    setState({});

    const { input, edges } = simulationInput(graph);
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (event: MessageEvent<LayoutMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        setState({ progress: { tick: message.tick, total: message.total } });
        return;
      }
      worker.terminate();
      if (message.type === "done") {
        setState({ layout: assembleLayout(graph, edges, message.positions) });
      } else {
        setState({ error: message.message });
      }
    };

    // A worker that fails to load, or throws outside the handler, never posts anything,
    // so this is the only place that failure shows up. Without it the app would wait
    // forever.
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      setState({ error: event.message || "The layout worker failed to start." });
    };

    const request: LayoutRequest = input;
    worker.postMessage(request, [
      input.linkSource.buffer,
      input.linkTarget.buffer,
      input.linkDistance.buffer,
    ]);

    // Terminating is how we cancel. The simulation is one synchronous loop, so killing
    // the worker is the only way to stop it early.
    return () => worker.terminate();
  }, [graph]);

  return state;
}
