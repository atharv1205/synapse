import { useEffect, useState } from "react";
import type { RepoGraph } from "@synapse/core";
import { GraphScene } from "../components/GraphScene";
import { useLayout } from "../useLayout";
import sample from "./sample-graph.json";

// The JSON's string fields widen to `string` on import, so it is asserted back to the
// shape scripts/sample-graph.mjs writes, which is a RepoGraph with the heavy parts empty.
const GRAPH = sample as unknown as RepoGraph;
const NONE: number[] = [];
const ignore = () => {};

/**
 * Synapse's own codebase, laid out and drawn by the same code as the explorer.
 *
 * It fades in from a blur once the layout lands. That is the page's one authored
 * moment: the graph resolving the way a stained sample comes into focus.
 */
export default function HeroGraph() {
  const { layout } = useLayout(GRAPH);
  const [shown, setShown] = useState(false);

  // Wait a frame after the canvas mounts so the transition has a start state to leave.
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
