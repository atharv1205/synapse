#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import {
  analyze,
  isRepoUrl,
  writeGraph,
  DEFAULT_MODEL,
  DEFAULT_SUMMARIZE_TOP,
  type RepoGraph,
} from "@synapse/core";

const USAGE = `synapse — map a codebase's structure and importance

Usage:
  synapse analyze <path-or-github-url> [options]

Options:
  --out <dir>            Where to write graph.json (default: <target>/.synapse)
  --depth <n>            Clone depth when given a URL (default: 200)
  --top <n>              How many files to list in the summary (default: 10)
  --skip-churn           Skip the git history pass

  --skip-summarize       Skip LLM summarisation entirely
  --model <name>         Ollama model (default: ${DEFAULT_MODEL})
  --summarize-top <n>    How many top files to summarise (default: ${DEFAULT_SUMMARIZE_TOP})
  --ollama-url <url>     Ollama base URL (default: http://localhost:11434)

  --json                 Print the graph to stdout instead of writing a file
  -h, --help             Show this message
`;

/** Wraps long text so multi-sentence summaries stay readable in a terminal. */
function wrap(text: string, indent: number, width = 92): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/)) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);

  return lines.join(`\n${pad}`);
}

/** Reports what summarisation actually did, including why it did nothing. */
function printSummarization(graph: RepoGraph): void {
  const report = graph.summarization;
  if (!report) return;

  if (!report.ran) {
    console.log("Summaries: skipped — no summaries were attached.");
    if (report.message) {
      console.log(report.message.split("\n").map((line) => `  ${line}`).join("\n"));
    }
    return;
  }

  console.log(
    `Summaries: ${report.generated} generated, ${report.fromCache} cached, ` +
      `${report.failed} failed (model: ${report.model})`,
  );
  if (report.failed > 0 && report.message) console.log(`  ${report.message}`);
}

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

  printSummarization(graph);

  if (graph.nodes.length === 0) return;

  console.log(`\nTop ${Math.min(top, graph.nodes.length)} files by importance:`);
  for (const node of graph.nodes.slice(0, top)) {
    const { inDegree, outDegree, churn } = node.metrics;
    console.log(`\n  ${node.importance.toFixed(4)}  ${node.path}`);
    console.log(`    in ${inDegree} · out ${outDegree} · ${churn} commits · ${node.metrics.loc} loc`);

    if (node.summary) console.log(`    ${wrap(node.summary, 4)}`);

    for (const fn of node.functions.filter((f) => f.summary).slice(0, 3)) {
      console.log(`      · ${fn.qualifiedName} — ${wrap(fn.summary!, 8)}`);
    }
  }
}

/**
 * Where graph.json and summaries.json live. A URL has no local path to hang them off,
 * so those land in the current directory rather than a folder named after the URL.
 */
function resolveOutDir(target: string, out: unknown): string {
  if (typeof out === "string") return path.resolve(out);
  if (isRepoUrl(target)) return path.join(process.cwd(), ".synapse");
  return path.join(path.resolve(target), ".synapse");
}

async function runAnalyze(target: string, values: Record<string, unknown>): Promise<void> {
  const outDir = resolveOutDir(target, values.out);

  const graph = await analyze(target, {
    depth: values.depth ? Number(values.depth) : undefined,
    skipChurn: values["skip-churn"] === true,
    skipSummarize: values["skip-summarize"] === true,
    model: typeof values.model === "string" ? values.model : undefined,
    ollamaUrl: typeof values["ollama-url"] === "string" ? values["ollama-url"] : undefined,
    summarizeTop: values["summarize-top"] ? Number(values["summarize-top"]) : undefined,
    cacheDir: outDir,
    // Progress goes to stderr so `--json` stdout stays machine-readable.
    onProgress: (message) => console.error(message),
  });

  if (values.json === true) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

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
      "skip-summarize": { type: "boolean" },
      model: { type: "string" },
      "summarize-top": { type: "string" },
      "ollama-url": { type: "string" },
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
