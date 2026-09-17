import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileNode, RepoGraph, SummarizationReport } from "../types.js";
import { SummaryCache, contentHash, type CachedSummary } from "./cache.js";
import { DEFAULT_MODEL, OllamaClient, type OllamaConfig } from "./ollama.js";
import {
  PROMPT_VERSION,
  SUMMARY_SCHEMA,
  TOP_FUNCTIONS_PER_FILE,
  buildFilePrompt,
  signatureOf,
  type RankedFunction,
  type SummaryResponse,
} from "./prompt.js";

export { OllamaClient, DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from "./ollama.js";
export { SummaryCache, contentHash, CACHE_FILENAME } from "./cache.js";
export { PROMPT_VERSION, MAX_SOURCE_CHARS, buildFilePrompt, truncateSource } from "./prompt.js";

/** The subset of OllamaClient summarisation needs, so tests can substitute a fake. */
export interface SummarizerBackend {
  readonly model: string;
  preflight(): Promise<{ ok: true } | { ok: false; message: string }>;
  generateJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
}

export const DEFAULT_SUMMARIZE_TOP = 50;

export interface SummarizeOptions extends OllamaConfig {
  /** Repo root, for reading file contents. */
  root: string;
  /** Where summaries.json lives. */
  cacheDir: string;
  /** How many of the most important files to summarise. */
  topN?: number;
  /** Concurrent requests to Ollama. Kept low: one local model serves them all. */
  concurrency?: number;
  /** Injected in tests; defaults to a real OllamaClient. */
  backend?: SummarizerBackend;
  onProgress?: (message: string) => void;
}

/**
 * Counts how many resolved call sites target each function, which is the ranking used
 * to pick the handful of functions per file that get their own summary.
 */
export function callCounts(graph: RepoGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graph.functionEdges) {
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + edge.weight);
  }
  return counts;
}

/** Picks a file's most-called functions, falling back to importance to break ties. */
export function rankFunctions(
  node: FileNode,
  counts: Map<string, number>,
  lines: string[],
  limit = TOP_FUNCTIONS_PER_FILE,
): RankedFunction[] {
  return node.functions
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

/** Anything carrying a summary field: a FunctionSymbol on a file node, or a FunctionNode. */
type Summarizable = { summary?: string };

/** Copies a cached or freshly generated summary onto the node and its functions. */
function attach(node: FileNode, entry: CachedSummary, byId: Map<string, Summarizable[]>): void {
  node.summary = entry.summary;
  for (const [qualifiedName, summary] of Object.entries(entry.functions)) {
    const symbol = node.functions.find((f) => f.qualifiedName === qualifiedName);
    if (!symbol) continue;
    symbol.summary = summary;
    // The function-level graph holds separate objects for the same declarations.
    for (const twin of byId.get(symbol.id) ?? []) twin.summary = summary;
  }
}

/**
 * Summarises the most important files in `graph` and attaches the results in place.
 *
 * Never throws for an unavailable Ollama or an unpulled model: those come back as a
 * report with `ran: false` and a remediation message, so the analyse run still produces
 * a graph. Individual file failures are counted and skipped for the same reason.
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

  const backend: SummarizerBackend = options.backend ?? new OllamaClient(options);
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
    return { ...base, message: preflight.message };
  }

  // graph.nodes is already sorted by importance descending.
  const selected = graph.nodes.slice(0, Math.max(0, topN));
  if (selected.length === 0) {
    return { ...base, ran: true, message: "No files to summarise." };
  }

  const counts = callCounts(graph);

  // Function-level nodes mirror the symbols on each file node; index them so a summary
  // written once lands on both representations.
  const twinsById = new Map<string, Summarizable[]>();
  for (const fn of graph.functionNodes) {
    const list = twinsById.get(fn.id);
    if (list) list.push(fn);
    else twinsById.set(fn.id, [fn]);
  }

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

      const cached = cache.get(hash, model, PROMPT_VERSION);
      if (cached) {
        attach(node, cached, twinsById);
        fromCache++;
        onProgress(`${position} cached  ${node.path}`);
        continue;
      }

      const ranked = rankFunctions(node, counts, source.split("\n"));
      const prompt = buildFilePrompt(node, source, ranked);

      try {
        const response = await backend.generateJson<SummaryResponse>(prompt, SUMMARY_SCHEMA);
        const entry = toEntry(node, model, response, ranked);
        cache.set(hash, entry);
        attach(node, entry, twinsById);
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
 * Normalises a model response into a cache entry. Only function names the file actually
 * declares are kept, so a hallucinated name cannot end up attached to the graph.
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
