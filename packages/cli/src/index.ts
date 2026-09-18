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
  DEFAULT_ANTHROPIC_MODEL,
  defaultModelFor,
  functionIndex,
  functionsOf,
  type ProviderName,
  type RepoGraph,
} from "@synapse/core";
import { serve } from "./serve.js";

const USAGE = `synapse — map a codebase's structure, importance and meaning

Usage:
  synapse analyze <path-or-github-url> [options]   Build the graph
  synapse index [path] [options]                   Build/refresh the embedding index
  synapse ask "<question>" [options]               Ask a question about the codebase
  synapse serve [path] [options]                   Serve the 3D UI and API

analyze:
  --out <dir>            Where to write graph.json (default: <target>/.synapse)
  --depth <n>            Clone depth when given a URL (default: 200)
  --token <token>        Credential for a private repository. Prefer the GITHUB_TOKEN
                         environment variable, which keeps it out of shell history.
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
  --global-rank          Rank purely by similarity, without reserving seats per
                         chunk kind (file vs function). Off by default.

serve:
  --path <dir>           Repo root (default: .)
  --port <n>             Port to listen on (default: 4317)
  --host <addr>          Address to bind (default: 127.0.0.1)
  --no-open              Do not open a browser window
  --skip-summarize       Skip summarisation if a graph has to be built first

Shared:
  --out <dir>            Where .synapse artefacts live (default: <path>/.synapse)
  --provider <name>      ollama | anthropic  (default: ollama)
                         Chooses what summarises and answers. Embeddings are always
                         Ollama — the Anthropic API has no embeddings endpoint — so
                         Ollama must be running for \`ask\` either way.
                         anthropic reads ANTHROPIC_API_KEY from the environment only.
  --model <name>         Chat model (default: ${DEFAULT_MODEL},
                         or ${DEFAULT_ANTHROPIC_MODEL} with --provider anthropic)
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

/** Validates --provider and reports the allowed values rather than failing obscurely. */
function providerFrom(values: Record<string, unknown>): ProviderName {
  const raw = values.provider;
  if (raw === undefined) return "ollama";
  if (raw === "ollama" || raw === "anthropic") return raw;
  console.error(`Unknown --provider "${String(raw)}". Use "ollama" or "anthropic".`);
  process.exit(1);
}

/**
 * The credential for a private clone. The flag wins over the environment when both are
 * present, but the environment is the better habit: a flag lands in shell history and
 * in this process's own argv.
 */
function tokenFrom(values: Record<string, unknown>): string | undefined {
  const flag = typeof values.token === "string" ? values.token.trim() : "";
  if (flag) return flag;
  const env = (process.env.GITHUB_TOKEN ?? "").trim();
  return env || undefined;
}

function llmOptions(values: Record<string, unknown>) {
  const provider = providerFrom(values);
  return {
    provider,
    model: typeof values.model === "string" ? values.model : defaultModelFor(provider),
    embedModel: typeof values["embed-model"] === "string" ? values["embed-model"] : undefined,
    baseUrl: typeof values["ollama-url"] === "string" ? values["ollama-url"] : undefined,
  };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

/**
 * Files missing from the graph. This is never expected to be non-zero, so it is
 * reported loudly rather than tucked into a debug flag: each missing file takes its
 * imports and declarations with it and skews every score computed from them.
 */
function printParseFailures(graph: RepoGraph): void {
  const failures = graph.parseFailures ?? [];
  if (failures.length === 0) return;

  console.log(`\nParse failures: ${failures.length} file(s) are MISSING from this graph.`);
  for (const failure of failures.slice(0, 10)) {
    console.log(`  ${failure.path}`);
    console.log(`    ${failure.reason.split("\n")[0]}`);
  }
  if (failures.length > 10) console.log(`  … and ${failures.length - 10} more`);
}

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

  printParseFailures(graph);
  printSummarization(graph);

  if (graph.nodes.length === 0 || top === 0) return;

  console.log(`\nTop ${Math.min(top, graph.nodes.length)} files by importance:`);
  const declarations = functionIndex(graph);

  for (const node of graph.nodes.slice(0, top)) {
    const { inDegree, outDegree, churn, loc } = node.metrics;
    console.log(`\n  ${node.importance.toFixed(4)}  ${node.path}`);
    console.log(`    in ${inDegree} · out ${outDegree} · ${churn} commits · ${loc} loc`);
    if (node.summary) console.log(`    ${wrap(node.summary, 4)}`);
    for (const fn of functionsOf(node, declarations).filter((f) => f.summary).slice(0, 3)) {
      console.log(`      · ${fn.qualifiedName} — ${wrap(fn.summary!, 8)}`);
    }
  }
}

async function runAnalyze(target: string, values: Record<string, unknown>): Promise<void> {
  const outDir = resolveOutDir(target, values.out);
  const llm = llmOptions(values);

  const graph = await analyze(target, {
    depth: values.depth ? Number(values.depth) : undefined,
    token: tokenFrom(values),
    skipChurn: values["skip-churn"] === true,
    skipSummarize: values["skip-summarize"] === true,
    provider: llm.provider,
    model: llm.model,
    ollamaUrl: llm.baseUrl,
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
  const llm = llmOptions(values);

  const graph = await loadGraph(outDir);

  const report = await buildIndex(graph, {
    root,
    cacheDir: outDir,
    embedModel: llm.embedModel,
    baseUrl: llm.baseUrl,
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
  const llm = llmOptions(values);

  // Loaded so a first `ask` can build its own index rather than demanding `index` first.
  const graph = await loadGraph(outDir);

  const result = await ask(question, {
    root,
    graph,
    cacheDir: outDir,
    topK: values["top-k"] ? Number(values["top-k"]) : undefined,
    globalRank: values["global-rank"] === true,
    provider: llm.provider,
    model: llm.model,
    embedModel: llm.embedModel,
    baseUrl: llm.baseUrl,
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
      provider: { type: "string" },
      token: { type: "string" },
      "embed-model": { type: "string" },
      "summarize-top": { type: "string" },
      "top-k": { type: "string" },
      "show-sources": { type: "boolean" },
      "global-rank": { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "no-open": { type: "boolean" },
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

    case "serve": {
      if (argument) values.path = values.path ?? argument;
      const root = path.resolve(typeof values.path === "string" ? values.path : ".");
      const llm = llmOptions(values);
      return serve({
        root,
        cacheDir: resolveOutDir(root, values.out),
        port: values.port ? Number(values.port) : 4317,
        host: typeof values.host === "string" ? values.host : "127.0.0.1",
        token: tokenFrom(values),
        provider: llm.provider,
        model: llm.model,
        embedModel: llm.embedModel,
        ollamaUrl: llm.baseUrl,
        skipSummarize: values["skip-summarize"] === true,
        summarizeTop: values["summarize-top"] ? Number(values["summarize-top"]) : undefined,
        noOpen: values["no-open"] === true,
      });
    }

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
