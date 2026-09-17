#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  analyze,
  ask,
  buildIndex,
  isRepoUrl,
  writeGraph,
  DEFAULT_EMBED_MODEL,
  DEFAULT_MODEL,
  DEFAULT_SUMMARIZE_TOP,
  DEFAULT_TOP_K,
  type RepoGraph,
} from "@synapse/core";

const USAGE = `synapse — map a codebase's structure, importance and meaning

Usage:
  synapse analyze <path-or-github-url> [options]   Build the graph
  synapse index [path] [options]                   Build/refresh the embedding index
  synapse ask "<question>" [options]               Ask a question about the codebase

analyze:
  --out <dir>            Where to write graph.json (default: <target>/.synapse)
  --depth <n>            Clone depth when given a URL (default: 200)
  --top <n>              How many files to list in the summary (default: 10)
  --skip-churn           Skip the git history pass
  --skip-summarize       Skip LLM summarisation entirely
  --summarize-top <n>    How many top files to summarise (default: ${DEFAULT_SUMMARIZE_TOP})
  --json                 Print the graph to stdout instead of writing a file

index:
  --path <dir>           Repo root, for recovering function signatures (default: .)

ask:
  --path <dir>           Repo root (default: .)
  --top-k <n>            How many chunks to retrieve (default: ${DEFAULT_TOP_K})
  --show-sources         List the files and functions the answer drew on

Shared:
  --out <dir>            Where .synapse artefacts live (default: <path>/.synapse)
  --model <name>         Chat model (default: ${DEFAULT_MODEL})
  --embed-model <name>   Embedding model (default: ${DEFAULT_EMBED_MODEL})
  --ollama-url <url>     Ollama base URL (default: http://localhost:11434)
  -h, --help             Show this message
`;

/** Wraps long text so multi-sentence output stays readable in a terminal. */
function wrap(text: string, indent = 0, width = 92): string {
  const pad = " ".repeat(indent);
  return text
    .split("\n")
    .map((paragraph) => {
      const lines: string[] = [];
      let current = "";
      for (const word of paragraph.split(/\s+/)) {
        if (current && current.length + word.length + 1 > width) {
          lines.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) lines.push(current);
      return lines.join(`\n${pad}`);
    })
    .join(`\n${pad}`);
}

/** Prints a multi-line remediation block indented under a heading. */
function printRemediation(message: string): void {
  console.error(message.split("\n").map((line) => `  ${line}`).join("\n"));
}

/**
 * Where .synapse artefacts live. A URL has no local path to hang them off, so those
 * land in the current directory rather than a folder named after the URL.
 */
function resolveOutDir(target: string, out: unknown): string {
  if (typeof out === "string") return path.resolve(out);
  if (isRepoUrl(target)) return path.join(process.cwd(), ".synapse");
  return path.join(path.resolve(target), ".synapse");
}

function ollamaOptions(values: Record<string, unknown>) {
  return {
    model: typeof values.model === "string" ? values.model : undefined,
    embedModel: typeof values["embed-model"] === "string" ? values["embed-model"] : undefined,
    baseUrl: typeof values["ollama-url"] === "string" ? values["ollama-url"] : undefined,
  };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

function printSummarization(graph: RepoGraph): void {
  const report = graph.summarization;
  if (!report) return;

  if (!report.ran) {
    console.log("Summaries: skipped — no summaries were attached.");
    if (report.message) printRemediation(report.message);
    return;
  }

  console.log(
    `Summaries: ${report.generated} generated, ${report.fromCache} cached, ` +
      `${report.failed} failed (model: ${report.model})`,
  );
  if (report.failed > 0 && report.message) console.log(`  ${report.message}`);
}

function printGraphSummary(graph: RepoGraph, top: number): void {
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

  if (graph.nodes.length === 0 || top === 0) return;

  console.log(`\nTop ${Math.min(top, graph.nodes.length)} files by importance:`);
  for (const node of graph.nodes.slice(0, top)) {
    const { inDegree, outDegree, churn, loc } = node.metrics;
    console.log(`\n  ${node.importance.toFixed(4)}  ${node.path}`);
    console.log(`    in ${inDegree} · out ${outDegree} · ${churn} commits · ${loc} loc`);
    if (node.summary) console.log(`    ${wrap(node.summary, 4)}`);
    for (const fn of node.functions.filter((f) => f.summary).slice(0, 3)) {
      console.log(`      · ${fn.qualifiedName} — ${wrap(fn.summary!, 8)}`);
    }
  }
}

async function runAnalyze(target: string, values: Record<string, unknown>): Promise<void> {
  const outDir = resolveOutDir(target, values.out);
  const ollama = ollamaOptions(values);

  const graph = await analyze(target, {
    depth: values.depth ? Number(values.depth) : undefined,
    skipChurn: values["skip-churn"] === true,
    skipSummarize: values["skip-summarize"] === true,
    model: ollama.model,
    ollamaUrl: ollama.baseUrl,
    summarizeTop: values["summarize-top"] ? Number(values["summarize-top"]) : undefined,
    cacheDir: outDir,
    onProgress: (message) => console.error(message),
  });

  if (values.json === true) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  printGraphSummary(graph, values.top === undefined ? 10 : Number(values.top));
  console.log(`\nWrote ${await writeGraph(graph, outDir)}`);
}

// ---------------------------------------------------------------------------
// index / ask
// ---------------------------------------------------------------------------

/** Reads the graph a previous `analyze` wrote, with a pointed error if it is absent. */
async function loadGraph(outDir: string): Promise<RepoGraph> {
  const file = path.join(outDir, "graph.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as RepoGraph;
  } catch {
    throw new Error(
      `No graph found at ${file}.\n  Run \`synapse analyze <path>\` first.`,
    );
  }
}

async function runIndex(values: Record<string, unknown>): Promise<void> {
  const root = path.resolve(typeof values.path === "string" ? values.path : ".");
  const outDir = resolveOutDir(root, values.out);
  const ollama = ollamaOptions(values);

  const graph = await loadGraph(outDir);

  const report = await buildIndex(graph, {
    root,
    cacheDir: outDir,
    embedModel: ollama.embedModel,
    baseUrl: ollama.baseUrl,
    onProgress: (message) => console.error(message),
  });

  if (!report.ran) {
    console.error("\nCould not build the embedding index.");
    if (report.message) printRemediation(report.message);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nIndexed ${report.total} chunks — ${report.embedded} embedded, ${report.reused} reused.`,
  );
  console.log(`Model: ${report.embedModel} (${report.dim} dimensions)`);
  console.log(`Wrote ${path.join(outDir, "embeddings.json")}`);
}

async function runAsk(question: string, values: Record<string, unknown>): Promise<void> {
  const root = path.resolve(typeof values.path === "string" ? values.path : ".");
  const outDir = resolveOutDir(root, values.out);
  const ollama = ollamaOptions(values);

  // Loaded so a first `ask` can build its own index rather than demanding `index` first.
  const graph = await loadGraph(outDir);

  const result = await ask(question, {
    root,
    graph,
    cacheDir: outDir,
    topK: values["top-k"] ? Number(values["top-k"]) : undefined,
    model: ollama.model,
    embedModel: ollama.embedModel,
    baseUrl: ollama.baseUrl,
    onProgress: (message) => console.error(message),
  });

  if (!result.ok) {
    console.error("\nCould not answer the question.");
    if (result.message) printRemediation(result.message);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${wrap(result.answer)}\n`);

  if (values["show-sources"] === true) {
    console.log("Sources:");
    for (const source of result.sources) {
      const where = source.ref
        ? `${source.path}:${source.startLine} ${source.ref}`
        : source.path;
      console.log(`  ${source.score.toFixed(4)}  [${source.kind}] ${where}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      path: { type: "string" },
      depth: { type: "string" },
      top: { type: "string" },
      "skip-churn": { type: "boolean" },
      "skip-summarize": { type: "boolean" },
      model: { type: "string" },
      "embed-model": { type: "string" },
      "summarize-top": { type: "string" },
      "top-k": { type: "string" },
      "show-sources": { type: "boolean" },
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

  const [command, argument] = positionals;

  switch (command) {
    case "analyze":
      if (!argument) {
        console.error(`analyze requires a path or GitHub URL\n${USAGE}`);
        process.exit(1);
      }
      return runAnalyze(argument, values);

    case "index":
      if (argument) values.path = values.path ?? argument;
      return runIndex(values);

    case "ask":
      if (!argument) {
        console.error(`ask requires a question, e.g. synapse ask "what does the parser do?"\n${USAGE}`);
        process.exit(1);
      }
      return runAsk(argument, values);

    default:
      console.error(`Unknown command: ${command}\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
