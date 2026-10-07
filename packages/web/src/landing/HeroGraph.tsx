import { useEffect, useState } from "react";
import type { RepoGraph } from "@synapse/core";
import { GraphScene } from "../components/GraphScene";
import { useLayout } from "../useLayout";
import sample from "./sample-graph.json";

// Importing JSON widens the string fields to `string`, so cast it back to what
// scripts/sample-graph.mjs writes: a RepoGraph with the heavy parts left empty.
const GRAPH = sample as unknown as RepoGraph;
const NONE: number[] = [];
const ignore = () => {};

/**
 * Synapse's own codebase, laid out and drawn by the same code as the explorer.
 *
 * It fades in from a blur once the layout is ready. That's the one bit of drama on the
 * page: the graph coming into focus like a stained sample under a microscope.
 */
export default function HeroGraph() {
  const { layout } = useLayout(GRAPH);
  const [shown, setShown] = useState(false);

  // Wait a frame after the canvas mounts so the transition has a starting state.
  useEffect(() => {
    if (!layout) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [layout]);

  return (
    <figure className="hero-figure">
      <div className={`hero-graph${shown ? " is-shown" : ""}`}>
        {layout && (
          <GraphScene
            mode="showcase"
            layout={layout}
            threshold={0}
            colorMode="importance"
            citedIndices={NONE}
            onSelect={ignore}
          />
        )}
      </div>
      <figcaption>
        <span>
          Synapse’s own source: {GRAPH.nodes.length} files and {GRAPH.edges.length} imports,
          coloured by importance. Drag to turn it.
        </span>
        <span className="ramp" aria-hidden="true">
          <span>low</span>
          <span className="ramp-bar" />
          <span>high</span>
        </span>
      </figcaption>
    </figure>
  );
}
