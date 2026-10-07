import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileNode, FunctionNode, RepoGraph, SummarizationReport } from "../types.js";
import { functionIndex, functionsOf } from "../graph/lookup.js";
import { SummaryCache, contentHash, type CachedSummary } from "./cache.js";
import { DEFAULT_MODEL } from "../llm/ollama.js";
import { createChatProvider, type ProviderOptions } from "../llm/provider.js";
import {
  PROMPT_VERSION,
  SUMMARY_SCHEMA,
  TOP_FUNCTIONS_PER_FILE,
  buildFilePrompt,
  signatureOf,
  type RankedFunction,
  type SummaryResponse,
} from "./prompt.js";

export { OllamaClient, DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from "../llm/ollama.js";
export { createChatProvider } from "../llm/provider.js";
export { SummaryCache, contentHash, CACHE_FILENAME } from "./cache.js";
export { PROMPT_VERSION, MAX_SOURCE_CHARS, buildFilePrompt, truncateSource } from "./prompt.js";

/**
 * The part of LlmProvider that summarising needs. Every client (Ollama, Gemini,
 * Anthropic) fits it, which is why the prompt code below doesn't care which one is in
 * use.
 */
export interface SummarizerBackend {
  readonly model: string;
  preflight(): Promise<{ ok: true } | { ok: false; message: string }>;
  generateJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
}

export const DEFAULT_SUMMARIZE_TOP = 50;

export interface SummarizeOptions extends ProviderOptions {
  /** Repo root, for reading files. */
  root: string;
  /** Where summaries.json lives. */
  cacheDir: string;
  /** How many of the top files to summarise. */
  topN?: number;
  /** Parallel requests. Kept low since one local model handles all of them. */
  concurrency?: number;
  /** Tests pass a fake here. Defaults to a real OllamaClient. */
  backend?: SummarizerBackend;
  onProgress?: (message: string) => void;
}

/**
 * Count how many resolved calls point at each function. That's how we pick the few
 * functions per file that get their own summary.
 */
export function callCounts(graph: RepoGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graph.functionEdges) {
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + edge.weight);
  }
  return counts;
}

/** A file's most-called functions, with importance as the tie-breaker. */
export function rankFunctions(
  declarations: FunctionNode[],
  counts: Map<string, number>,
  lines: string[],
  limit = TOP_FUNCTIONS_PER_FILE,
): RankedFunction[] {
  return declarations
    .map((symbol) => ({
      symbol,
      callCount: counts.get(symbol.id) ?? 0,
      signature: signatureOf(symbol, lines),
    }))
    .sort(
      (a, b) =>
        b.callCount - a.callCount ||
        b.symbol.importance - a.symbol.importance ||
        a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName),
    )
    .slice(0, limit);
}

/**
 * Copy a cached or fresh summary onto the file node and its declarations.
 *
 * Declarations only exist once now, in `functionNodes`, so writing the summary once is
 * enough. No second copy on the file node to keep in sync.
 */
function attach(node: FileNode, entry: CachedSummary, declarations: FunctionNode[]): void {
  node.summary = entry.summary;
  for (const [qualifiedName, summary] of Object.entries(entry.functions)) {
    const fn = declarations.find((f) => f.qualifiedName === qualifiedName);
    if (fn) fn.summary = summary;
  }
}

/**
 * Summarise the top files in `graph` and attach the results in place.
 *
 * Doesn't throw if Ollama is down or the model isn't pulled. You get a report with
 * `ran: false` and what to do, so analyse still produces a graph. Single files that fail
 * are counted and skipped for the same reason.
 */
export async function summarizeGraph(
  graph: RepoGraph,
  options: SummarizeOptions,
): Promise<SummarizationReport> {
  const {
    root,
    cacheDir,
    topN = DEFAULT_SUMMARIZE_TOP,
    concurrency = 2,
    onProgress = () => {},
  } = options;

  const backend: SummarizerBackend = options.backend ?? createChatProvider(options);
  const model = backend.model;

  const base: SummarizationReport = {
    ran: false,
    model,
    selected: 0,
    fromCache: 0,
    generated: 0,
    failed: 0,
  };

  const preflight = await backend.preflight();
  if (!preflight.ok) {
    // preflight is shared with the RAG code, so the --skip-summarize hint gets added
    // here.
    return { ...base, message: `${preflight.message}\n  Or skip this pass with --skip-summarize.` };
  }

  // graph.nodes is already sorted by importance, highest first.
  const selected = graph.nodes.slice(0, Math.max(0, topN));
  if (selected.length === 0) {
    return { ...base, ran: true, message: "No files to summarise." };
  }

  const counts = callCounts(graph);
  const declarations = functionIndex(graph);

  const cache = await SummaryCache.load(cacheDir);
  const liveHashes = new Set<string>();

  let fromCache = 0;
  let generated = 0;
  let failed = 0;
  let done = 0;

  const queue = [...selected];

  async function worker(): Promise<void> {
    for (;;) {
      const node = queue.shift();
      if (!node) return;

      done++;
      const position = `[${done}/${selected.length}]`;

      let source: string;
      try {
        source = await readFile(path.join(root, node.path), "utf8");
      } catch {
        failed++;
        onProgress(`${position} skipped ${node.path} (unreadable)`);
        continue;
      }

      const hash = contentHash(node.path, source);
      liveHashes.add(hash);

      const own = functionsOf(node, declarations);

      const cached = cache.get(hash, model, PROMPT_VERSION);
      if (cached) {
        attach(node, cached, own);
        fromCache++;
        onProgress(`${position} cached  ${node.path}`);
        continue;
      }

      const ranked = rankFunctions(own, counts, source.split("\n"));
      const prompt = buildFilePrompt(node, own, source, ranked);

      try {
        const response = await backend.generateJson<SummaryResponse>(prompt, SUMMARY_SCHEMA);
        const entry = toEntry(node, model, response, ranked);
        cache.set(hash, entry);
        attach(node, entry, own);
        generated++;
        onProgress(`${position} summarised ${node.path}`);
      } catch (error) {
        failed++;
        const reason = error instanceof Error ? error.message : String(error);
        onProgress(`${position} failed  ${node.path}: ${reason}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), selected.length) }, worker),
  );

  await cache.save(liveHashes);

  const report: SummarizationReport = {
    ran: true,
    model,
    selected: selected.length,
    fromCache,
    generated,
    failed,
  };

  if (failed > 0) {
    report.message = `${failed} file(s) could not be summarised and carry no summary.`;
  }

  return report;
}

/**
 * Turn a model response into a cache entry. We only keep function names the file really
 * declares, so a made-up name can't end up in the graph.
 */
function toEntry(
  node: FileNode,
  model: string,
  response: SummaryResponse,
  ranked: RankedFunction[],
): CachedSummary {
  const allowed = new Map<string, string>();
  for (const { symbol } of ranked) {
    allowed.set(symbol.qualifiedName.toLowerCase(), symbol.qualifiedName);
    allowed.set(symbol.name.toLowerCase(), symbol.qualifiedName);
  }

  const functions: Record<string, string> = {};
  for (const item of response.functions ?? []) {
    if (typeof item?.name !== "string" || typeof item.summary !== "string") continue;
    const qualified = allowed.get(item.name.trim().toLowerCase());
    if (!qualified) continue;
    functions[qualified] = item.summary.trim();
  }

  return {
    path: node.path,
    model,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    summary: (response.summary ?? "").trim(),
    functions,
  };
}
