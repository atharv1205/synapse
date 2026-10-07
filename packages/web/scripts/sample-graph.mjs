#!/usr/bin/env node
// Regenerates the sample graph the landing page shows (it's Synapse's own code).
//
//   node packages/cli/dist/src/index.js analyze . --skip-summarize --out /tmp/self
//   npm run sample-graph --workspace @synapse/web -- /tmp/self/graph.json
//
// Strips it down to what the hero actually draws (files, metrics, import edges), which
// takes it from ~150KB to ~28KB. Also replaces `source`, since that's the absolute path
// on whoever's machine ran it.
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
