import { useCallback, useEffect, useMemo, useState } from "react";
import type { RepoGraph } from "@synapse/core";
import { api, ApiError, type Status } from "./api";
import { computeLayout } from "./layout";
import { AskPanel } from "./components/AskPanel";
import { GraphScene, type ColorMode } from "./components/GraphScene";
import { NodeDetails } from "./components/NodeDetails";
import { StatusBanner, StatusGate } from "./components/StatusGate";
import { Toolbar } from "./components/Toolbar";

/**
 * Above this many files the view starts with a threshold that keeps roughly this many
 * nodes prominent, so a large repo opens on its important files rather than a hairball.
 * Everything is still rendered and still clickable — the threshold only fades.
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

  const [threshold, setThreshold] = useState(0);
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

  // The layout is expensive and deterministic, so it runs once per graph.
  const layout = useMemo(() => (graph ? computeLayout(graph) : undefined), [graph]);

  const maxImportance = useMemo(
    () => layout?.nodes.reduce((max, n) => Math.max(max, n.node.importance), 0) ?? 1,
    [layout],
  );

  // Pick an opening threshold that leaves about PROMINENT_TARGET nodes prominent.
  useEffect(() => {
    if (!layout) return;
    if (layout.nodes.length <= PROMINENT_TARGET) {
      setThreshold(0);
      return;
    }
    const sorted = layout.nodes
      .map((n) => n.node.importance)
      .sort((a, b) => b - a);
    setThreshold(sorted[PROMINENT_TARGET] ?? 0);
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

  const visibleCount = useMemo(
    () => layout?.nodes.filter((n) => n.node.importance >= threshold).length ?? 0,
    [layout, threshold],
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

  if (graphError) {
    return (
      <div className="splash">
        <div className="splash-card">
          <h1>Could not load the graph</h1>
          <pre className="remediation">{graphError}</pre>
        </div>
      </div>
    );
  }

  if (!graph || !layout) {
    return (
      <div className="splash">
        <div className="splash-card">
          <h1>Loading graph …</h1>
          <div className="spinner" aria-label="Loading" />
        </div>
      </div>
    );
  }

  const selectedNode = selected !== undefined ? graph.nodes[selected] : undefined;
  const askUnavailable =
    status && !status.canAsk
      ? (status.chatModel.message ?? status.embedModel.message ?? "Questions are unavailable.")
      : undefined;

  return (
    <div className="app">
      <Toolbar
        fileCount={layout.nodes.length}
        visibleCount={visibleCount}
        threshold={threshold}
        maxImportance={maxImportance}
        colorMode={colorMode}
        indexing={indexing}
        indexMessage={indexMessage}
        onThresholdChange={setThreshold}
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
