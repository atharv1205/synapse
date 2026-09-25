#!/usr/bin/env node
/**
 * Regenerates the landing page's sample graph from a real analysis.
 *
 *   node packages/cli/dist/src/index.js analyze . --skip-summarize --out /tmp/self
 *   npm run sample-graph --workspace @synapse/web -- /tmp/self/graph.json
 *
 * The landing hero renders Synapse's own codebase, so it shows the real product on
 * real data rather than a mock-up. Only what the scene draws is kept: file nodes with
 * their metrics and the import edges. Summaries, declarations and function edges are
 * dropped, which takes a graph of this repo from ~150KB to ~28KB. `source` is replaced
 * too, because the real one is the absolute path of whoever ran the analysis.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("Usage: sample-graph <path/to/graph.json>");
  process.exit(1);
}

const graph = JSON.parse(readFileSync(source, "utf8"));
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../src/landing/sample-graph.json");

const sample = {
  version: graph.version,
  source: "synapse",
  generatedAt: graph.generatedAt,
  stats: graph.stats,
  nodes: graph.nodes.map(({ id, path, type, language, importance, metrics }) => ({
    id,
    path,
    type,
    language,
    importance,
    metrics,
    functions: [],
  })),
  edges: graph.edges,
  functionNodes: [],
  functionEdges: [],
  parseFailures: [],
};

writeFileSync(out, JSON.stringify(sample) + "\n");
console.log(`Wrote ${sample.nodes.length} files and ${sample.edges.length} edges to ${out}`);
