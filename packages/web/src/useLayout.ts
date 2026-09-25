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
  /** Set only once a layout has run long enough to be worth showing progress for. */
  progress?: LayoutProgress;
  error?: string;
}

/**
 * Lays a graph out in a Web Worker, once per graph.
 *
 * On home-assistant/core (18,851 files) the simulation is 150 ticks at roughly a
 * quarter of a second each. Run inside a useMemo, as it used to be, that froze the tab
 * for 38 seconds on a blank screen; in a worker the page keeps painting and can show
 * how far along it is. Only flat typed arrays cross the boundary in either direction,
 * and both are transferred rather than copied.
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

    // A worker that fails to load or throws outside the handler never posts, so this is
    // the only way that failure surfaces — without it the app would wait forever.
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

    // Terminating is what cancels a run: the simulation is one synchronous loop, so
    // nothing short of killing the worker stops it early.
    return () => worker.terminate();
  }, [graph]);

  return state;
}
