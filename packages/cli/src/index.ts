#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { analyze, writeGraph, type RepoGraph } from "@repograph/core";

const USAGE = `repograph — map a codebase's structure and importance

Usage:
  repograph analyze <path-or-github-url> [options]

Options:
  --out <dir>       Where to write graph.json (default: <target>/.repograph)
  --depth <n>       Clone depth when given a URL (default: 200)
  --top <n>         How many files to list in the summary (default: 10)
  --skip-churn      Skip the git history pass
  --json            Print the graph to stdout instead of writing a file
  -h, --help        Show this message
`;

/** Renders the leaderboard that makes a run's result legible at a glance. */
function printSummary(graph: RepoGraph, top: number): void {
  const { stats } = graph;

  console.log(`\nSource:    ${graph.source}`);
  console.log(`Files:     ${stats.fileCount}`);
  console.log(`Imports:   ${stats.edgeCount} internal, ${stats.externalImports} external`);
  console.log(`Functions: ${stats.functionCount} (${stats.functionEdgeCount} call edges)`);
  console.log(
    `Churn:     ${stats.churnAvailable ? "from git history" : "unavailable (not a git repo)"}`,
  );

  const languages = Object.entries(stats.byLanguage).sort((a, b) => b[1] - a[1]);
  if (languages.length > 0) {
    console.log(`Languages: ${languages.map(([l, n]) => `${l} ${n}`).join(", ")}`);
  }

  if (graph.nodes.length === 0) return;

  console.log(`\nTop ${Math.min(top, graph.nodes.length)} files by importance:`);
  console.log(`  ${"score".padEnd(7)} ${"in".padStart(4)} ${"out".padStart(4)} ${"churn".padStart(6)}  path`);
  for (const node of graph.nodes.slice(0, top)) {
    const { inDegree, outDegree, churn } = node.metrics;
    console.log(
      `  ${node.importance.toFixed(4).padEnd(7)} ${String(inDegree).padStart(4)} ${String(outDegree).padStart(4)} ${String(churn).padStart(6)}  ${node.path}`,
    );
  }

  const topFunctions = graph.functionNodes.filter((f) => f.importance > 0).slice(0, top);
  if (topFunctions.length > 0) {
    console.log(`\nTop ${topFunctions.length} functions by importance:`);
    for (const fn of topFunctions) {
      console.log(`  ${fn.importance.toFixed(4)}  ${fn.file}:${fn.startLine}  ${fn.qualifiedName}`);
    }
  }
}

async function runAnalyze(target: string, values: Record<string, unknown>): Promise<void> {
  const asJson = values.json === true;

  const graph = await analyze(target, {
    depth: values.depth ? Number(values.depth) : undefined,
    skipChurn: values["skip-churn"] === true,
    // Progress goes to stderr so `--json` stdout stays machine-readable.
    onProgress: (message) => console.error(message),
  });

  if (asJson) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  const outDir =
    typeof values.out === "string"
      ? path.resolve(values.out)
      : path.join(path.resolve(target), ".repograph");

  printSummary(graph, values.top ? Number(values.top) : 10);
  const written = await writeGraph(graph, outDir);
  console.log(`\nWrote ${written}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      depth: { type: "string" },
      top: { type: "string" },
      "skip-churn": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const [command, target] = positionals;

  if (command !== "analyze") {
    console.error(`Unknown command: ${command}\n${USAGE}`);
    process.exit(1);
  }

  if (!target) {
    console.error(`analyze requires a path or GitHub URL\n${USAGE}`);
    process.exit(1);
  }

  await runAnalyze(target, values);
}

main().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
