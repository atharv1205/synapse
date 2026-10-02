import { useCallback, useEffect, useMemo, useState } from "react";
import type { RepoGraph } from "@synapse/core";
import { functionIndex, functionsOf } from "./graph";
import { api, ApiError, repoNameOf, type Status } from "./api";
import { AskPanel } from "./components/AskPanel";
import { GraphScene, type ColorMode } from "./components/GraphScene";
import { NodeDetails } from "./components/NodeDetails";
import { Splash, Spinner, StatusBanner, StatusGate } from "./components/StatusGate";
import { Toolbar } from "./components/Toolbar";
import { useLayout } from "./useLayout";
import { buildClustering, type Cluster } from "./clusters";
import { ClusterDetails } from "./components/ClusterDetails";
import type { ClusterView } from "./components/GraphScene";
import { useProviderChoice } from "./components/ProviderSwitch";
import "./styles/app.css";

/**
 * How many files the view aims to show prominently on load, so a large repo opens on
 * its important files rather than a hairball. Everything is still rendered and still
 * clickable — the cutoff only fades.
 */
const PROMINENT_TARGET = 300;

/**
 * Above this many files the explorer opens on folders rather than files: a few dozen
 * bubbles instead of thousands of dots. Below it the files themselves are readable.
 */
const FOLDERS_ABOVE = 400;

export type ViewMode = "files" | "folders";

/**
 * How much of the scene's right edge the panel column covers on wide screens: its 380px
 * width, its 16px inset, and 16px of air. Matches .panels in styles/app.css, which
 * stacks the panels under the scene instead at 860px and below.
 */
const PANEL_COLUMN = 380 + 16 + 16;
const PANELS_OVERLAY = "(min-width: 861px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const sync = () => setMatches(list.matches);
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

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
  const [viewMode, setViewMode] = useState<ViewMode>("files");
  // Cluster indices showing their files rather than a bubble, in the folders view.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [selectedCluster, setSelectedCluster] = useState<number | undefined>();
  const [focusCluster, setFocusCluster] = useState<Cluster | undefined>();
  const [colorMode, setColorMode] = useState<ColorMode>("importance");
  const [indexing, setIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | undefined>();
  const panelsOverlay = useMediaQuery(PANELS_OVERLAY);
  // Who answers questions and rebuilds the index. Until the viewer picks, the provider
  // `serve` was started with applies; the choice is remembered in this browser.
  const [choice, choose] = useProviderChoice();
  const provider = choice ?? status?.defaultProvider;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status(choice));
      setStatusError(undefined);
    } catch (caught) {
      setStatusError(caught instanceof ApiError ? caught.message : String(caught));
    }
  }, [choice]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    document.title = status ? `${repoNameOf(status.root)}: Synapse` : "Synapse";
  }, [status]);

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

  const clustering = useMemo(
    () =>
      layout
        ? buildClustering(
            layout.nodes.map((n) => ({ index: n.index, path: n.node.path, importance: n.node.importance, x: n.x, y: n.y, z: n.z })),
            layout.edges,
          )
        : undefined,
    [layout],
  );

  // Big repositories open on folders; each new graph starts with every folder collapsed.
  useEffect(() => {
    if (!layout) return;
    setViewMode(layout.nodes.length > FOLDERS_ABOVE ? "folders" : "files");
    setExpanded(new Set());
    setSelectedCluster(undefined);
  }, [layout]);

  const folders = viewMode === "folders" && clustering !== undefined;

  /** Per node index, 1 for files inside a collapsed folder. */
  const hidden = useMemo(() => {
    if (!folders || !clustering) return undefined;
    const mask = new Uint8Array(clustering.clusterOf.length);
    clustering.clusterOf.forEach((cluster, i) => {
      if (!expanded.has(cluster)) mask[i] = 1;
    });
    return mask;
  }, [folders, clustering, expanded]);

  const clusterView = useMemo<ClusterView | undefined>(() => {
    if (!folders || !clustering) return undefined;
    const collapsed = new Uint8Array(clustering.clusters.length);
    clustering.clusters.forEach((_, i) => {
      if (!expanded.has(i)) collapsed[i] = 1;
    });
    return {
      clusters: clustering.clusters,
      edges: clustering.edges,
      collapsed,
      selected: selectedCluster,
      onSelect: (cluster: number) => {
        setSelected(undefined);
        setSelectedCluster(cluster);
        setFocusCluster(clustering.clusters[cluster]);
      },
    };
  }, [folders, clustering, expanded, selectedCluster]);

  const toggleCluster = useCallback((cluster: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(cluster)) next.delete(cluster);
      else next.add(cluster);
      return next;
    });
  }, []);

  /** Makes a file visible in the folders view by expanding the folder it is in. */
  const reveal = useCallback(
    (index: number) => {
      const cluster = clustering?.clusterOf[index];
      if (cluster === undefined || cluster < 0) return;
      setExpanded((current) => (current.has(cluster) ? current : new Set(current).add(cluster)));
    },
    [clustering],
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
        setSelectedCluster(undefined);
        return;
      }
      setSelectedCluster(undefined);
      setSelected(index);
      setFocusIndex(index);
    },
    [],
  );

  const handleFocusSource = useCallback(
    (path: string) => {
      const index = indexByPath.get(path);
      if (index === undefined) return;
      // A cited file may sit inside a collapsed folder; open the folder so it can be seen.
      reveal(index);
      setSelectedCluster(undefined);
      setSelected(index);
      setFocusIndex(index);
    },
    [indexByPath, reveal],
  );

  const handleReindex = useCallback(async () => {
    setIndexing(true);
    setIndexMessage(undefined);
    try {
      const report = await api.buildIndex(provider);
      setIndexMessage(`${report.total} chunks (${report.embedded} new, ${report.reused} reused)`);
      await refreshStatus();
    } catch (caught) {
      setIndexMessage(caught instanceof ApiError ? caught.message.split("\n")[0] : String(caught));
    } finally {
      setIndexing(false);
    }
  }, [refreshStatus, provider]);

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
      <h1 className="visually-hidden">
        {status ? `${repoNameOf(status.root)} dependency graph` : "Dependency graph"}
      </h1>
      <Toolbar
        repoName={status ? repoNameOf(status.root) : undefined}
        repository={graph.repository}
        fileCount={layout.nodes.length}
        visibleCount={visibleCount}
        topPercent={topPercent}
        colorMode={colorMode}
        indexing={indexing}
        indexMessage={indexMessage}
        onTopPercentChange={setTopPercent}
        onColorModeChange={setColorMode}
        onReindex={() => void handleReindex()}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          setSelectedCluster(undefined);
        }}
        expandedCount={folders ? expanded.size : 0}
        onCollapseAll={() => setExpanded(new Set())}
        provider={provider}
        providers={status?.providers}
        onProviderChange={choose}
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
          occludedRight={panelsOverlay ? PANEL_COLUMN : 0}
          hidden={hidden}
          clusterView={clusterView}
          focusCluster={focusCluster}
        />

        {/* Inside the scene so the panels sit against the canvas regardless of how
            tall the toolbar and any status banner above it happen to be. */}
        <div className="panels">
          {clustering && selectedCluster !== undefined && clustering.clusters[selectedCluster] && (
            <ClusterDetails
              cluster={clustering.clusters[selectedCluster]!}
              files={clustering.clusters[selectedCluster]!.members
                .map((i) => graph.nodes[i]!)
                .sort((a, b) => b.importance - a.importance)}
              expanded={expanded.has(selectedCluster)}
              onToggle={() => toggleCluster(selectedCluster)}
              onOpenFile={handleFocusSource}
              onAskAbout={(question) => setPrefill(question)}
              onClose={() => setSelectedCluster(undefined)}
            />
          )}
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
            provider={provider}
            unavailableMessage={askUnavailable}
            onFocusSource={handleFocusSource}
            onSourcesChange={setCitedPaths}
          />
        </div>
      </div>
    </div>
  );
}
