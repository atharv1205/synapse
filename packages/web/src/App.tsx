import { useCallback, useEffect, useMemo, useState } from "react";
import type { RepoGraph } from "@synapse/core";
import { functionIndex, functionsOf } from "./graph";
import { api, ApiError, type Status } from "./api";
import { AskPanel } from "./components/AskPanel";
import { GraphScene, type ColorMode } from "./components/GraphScene";
import { NodeDetails } from "./components/NodeDetails";
import { Splash, Spinner, StatusBanner, StatusGate } from "./components/StatusGate";
import { Toolbar } from "./components/Toolbar";
import { useLayout } from "./useLayout";

/**
 * How many files the view aims to show prominently on load, so a large repo opens on
 * its important files rather than a hairball. Everything is still rendered and still
 * clickable — the cutoff only fades.
 */
const PROMINENT_TARGET = 300;

/** How often to re-poll status while waiting for a graph to appear. */
const POLL_MS = 2500;

export function App() {
  const [status, setStatus] = useState<Status | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [graph, setGraph] = useState<RepoGraph | undefined>();
  const [graphError, setGraphError] = useState<string | undefined>();

  const [selected, setSelected] = useState<number | undefined>();
  const [focusIndex, setFocusIndex] = useState<number | undefined>();
  const [prefill, setPrefill] = useState<string | undefined>();
  const [citedPaths, setCitedPaths] = useState<string[]>([]);

  const [topPercent, setTopPercent] = useState(100);
  const [colorMode, setColorMode] = useState<ColorMode>("importance");
  const [indexing, setIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | undefined>();

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setStatusError(undefined);
    } catch (caught) {
      setStatusError(caught instanceof ApiError ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Poll only while there is no graph yet — once it exists there is nothing to wait for.
  useEffect(() => {
    if (status?.graph.exists || statusError) return;
    const timer = setInterval(() => void refreshStatus(), POLL_MS);
    return () => clearInterval(timer);
  }, [status?.graph.exists, statusError, refreshStatus]);

  useEffect(() => {
    if (!status?.graph.exists || graph) return;
    void (async () => {
      try {
        setGraph(await api.graph());
      } catch (caught) {
        setGraphError(caught instanceof ApiError ? caught.message : String(caught));
      }
    })();
  }, [status?.graph.exists, graph]);

  // The layout is expensive and deterministic, so it runs once per graph, off the main thread.
  const { layout, progress: layoutProgress, error: layoutError } = useLayout(graph);

  /** Importance of every node, descending — the rank ladder the slider indexes into. */
  const ranked = useMemo(
    () => (layout ? layout.nodes.map((n) => n.node.importance).sort((a, b) => b - a) : []),
    [layout],
  );

  /** How many files the current percentile keeps prominent; always at least one. */
  const visibleCount = useMemo(
    () => (ranked.length === 0 ? 0 : Math.max(1, Math.round((ranked.length * topPercent) / 100))),
    [ranked, topPercent],
  );

  /**
   * The importance cutoff the scene filters on, read off the rank ladder. Deriving it
   * from rank rather than exposing it directly is what makes the control usable: the
   * raw values bunch up near zero, but their ordering is evenly spread by definition.
   */
  const threshold = useMemo(
    () => (visibleCount === 0 ? 0 : (ranked[visibleCount - 1] ?? 0)),
    [ranked, visibleCount],
  );

  // Open on roughly PROMINENT_TARGET files, whatever the graph's size.
  useEffect(() => {
    if (!layout) return;
    const count = layout.nodes.length;
    setTopPercent(count <= PROMINENT_TARGET ? 100 : Math.max(0.1, (PROMINENT_TARGET / count) * 100));
  }, [layout]);

  const indexByPath = useMemo(() => {
    const map = new Map<string, number>();
    layout?.nodes.forEach((n) => map.set(n.node.path, n.index));
    return map;
  }, [layout]);

  const citedIndices = useMemo(
    () => citedPaths.map((p) => indexByPath.get(p)).filter((i): i is number => i !== undefined),
    [citedPaths, indexByPath],
  );

  const handleSelect = useCallback(
    (index: number) => {
      // -1 is the scene's signal that empty space was clicked.
      if (index < 0) {
        setSelected(undefined);
        return;
      }
      setSelected(index);
      setFocusIndex(index);
    },
    [],
  );

  const handleFocusSource = useCallback(
    (path: string) => {
      const index = indexByPath.get(path);
      if (index === undefined) return;
      setSelected(index);
      setFocusIndex(index);
    },
    [indexByPath],
  );

  const handleReindex = useCallback(async () => {
    setIndexing(true);
    setIndexMessage(undefined);
    try {
      const report = await api.buildIndex();
      setIndexMessage(`${report.total} chunks (${report.embedded} new, ${report.reused} reused)`);
      await refreshStatus();
    } catch (caught) {
      setIndexMessage(caught instanceof ApiError ? caught.message.split("\n")[0] : String(caught));
    } finally {
      setIndexing(false);
    }
  }, [refreshStatus]);

  const gate = StatusGate({ status, error: statusError, onRetry: () => void refreshStatus() });
  if (gate) return gate;

  if (graphError || layoutError) {
    return (
      <Splash title={graphError ? "Could not load the graph" : "Could not lay out the graph"}>
        <pre className="remediation">{graphError ?? layoutError}</pre>
      </Splash>
    );
  }

  if (graph && !layout && layoutProgress) {
    const { tick, total } = layoutProgress;
    return (
      <Splash title={`Laying out ${graph.nodes.length.toLocaleString()} files`}>
        <Spinner />
        <p className="muted">
          Settling node positions with a force simulation. This runs once per load, in the
          background; large repositories take a while.
        </p>
        <progress className="layout-progress" value={tick} max={total} />
        <p className="progress">
          Tick {tick} of {total} · {Math.floor((tick / total) * 100)}%
        </p>
      </Splash>
    );
  }

  if (!graph || !layout) {
    return (
      <Splash title="Loading graph …">
        <Spinner />
      </Splash>
    );
  }

  const selectedNode = selected !== undefined ? graph.nodes[selected] : undefined;
  const selectedDeclarations = selectedNode
    ? functionsOf(selectedNode, functionIndex(graph))
    : [];
  const askUnavailable =
    status && !status.canAsk
      ? (status.chatModel.message ?? status.embedModel.message ?? "Questions are unavailable.")
      : undefined;

  return (
    <div className="app">
      <Toolbar
        fileCount={layout.nodes.length}
        visibleCount={visibleCount}
        topPercent={topPercent}
        colorMode={colorMode}
        indexing={indexing}
        indexMessage={indexMessage}
        onTopPercentChange={setTopPercent}
        onColorModeChange={setColorMode}
        onReindex={() => void handleReindex()}
      />

      {status && <StatusBanner status={status} />}

      <div className="scene">
        <GraphScene
          layout={layout}
          threshold={threshold}
          colorMode={colorMode}
          selectedIndex={selected}
          citedIndices={citedIndices}
          focusIndex={focusIndex}
          onSelect={handleSelect}
        />

        {/* Inside the scene so the panels sit against the canvas regardless of how
            tall the toolbar and any status banner above it happen to be. */}
        <div className="panels">
          {selectedNode && (
            <NodeDetails
              node={selectedNode}
              declarations={selectedDeclarations}
              onAskAbout={(question) => setPrefill(question)}
              onClose={() => setSelected(undefined)}
            />
          )}
          <AskPanel
            prefill={prefill}
            canAsk={status?.canAsk ?? false}
            unavailableMessage={askUnavailable}
            onFocusSource={handleFocusSource}
            onSourcesChange={setCitedPaths}
          />
        </div>
      </div>
    </div>
  );
}
