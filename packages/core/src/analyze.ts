import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveSource } from "./ingest/source.js";
import { walkSourceFiles } from "./ingest/walk.js";
import { parseFile, type ParsedFile } from "./parse/extract.js";
import { buildGraph } from "./graph/build.js";
import { measureChurn } from "./graph/churn.js";
import type { ScoreWeights } from "./graph/score.js";
import { summarizeGraph, type SummarizerBackend } from "./summarize/index.js";
import type { ProviderName } from "./llm/types.js";
import type { ParseFailure, RepoGraph } from "./types.js";

export interface AnalyzeOptions {
  /** Clone depth when the target is a URL. */
  depth?: number;
  /**
   * Credential for cloning a private repository. Passed straight to the clone step and
   * never stored: the graph records the redacted URL, not this.
   */
  token?: string;
  /** Blend of centrality and churn; defaults to 70/30. */
  weights?: ScoreWeights;
  /** Skip the git history pass. */
  skipChurn?: boolean;
  /** Skip the LLM summarisation pass entirely. */
  skipSummarize?: boolean;
  /** Which backend summarises: the local Ollama model, or the Anthropic API. */
  provider?: ProviderName;
  /** Chat model. Defaults to the chosen provider's own default. */
  model?: string;
  /** Ollama base URL, if not the local default. */
  ollamaUrl?: string;
  /** How many of the most important files to summarise. */
  summarizeTop?: number;
  /**
   * Where summaries.json is read and written. Summarisation is skipped when this is
   * absent, because there would be nowhere to cache results.
   */
  cacheDir?: string;
  /** Injected in tests so the suite never reaches a real model. */
  summarizeBackend?: SummarizerBackend;
  onProgress?: (message: string) => void;
}

/** Runs the full pipeline: ingest, parse, resolve, score. Does not write anything to disk. */
export async function analyze(target: string, options: AnalyzeOptions = {}): Promise<RepoGraph> {
  const { onProgress = () => {} } = options;
  const source = await resolveSource(target, {
    depth: options.depth,
    token: options.token,
    onProgress,
  });

  try {
    onProgress("Listing source files …");
    const { files, manifests } = await walkSourceFiles(source.root);
    onProgress(`Found ${files.length} source files.`);

    onProgress("Parsing …");
    const parsed = new Map<string, ParsedFile>();
    const parseFailures: ParseFailure[] = [];

    for (const file of files) {
      try {
        const contents = await readFile(file.absPath, "utf8");
        parsed.set(file.path, parseFile(file.path, contents, file.language));
      } catch (error) {
        // A file that cannot be read or parsed drops out of the graph rather than
        // failing the run — but it is recorded rather than swallowed. A silent gap here
        // removes that file's imports and symbols and quietly skews every score, which
        // is exactly how the 32KB parser limit went unnoticed.
        parseFailures.push({
          path: file.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (parseFailures.length > 0) {
      onProgress(`${parseFailures.length} file(s) could not be parsed and are missing from the graph.`);
    }

    onProgress("Measuring git churn …");
    const churn = options.skipChurn
      ? { counts: new Map<string, number>(), available: false }
      : await measureChurn(source.root, files.map((f) => f.path));

    onProgress("Building graph …");
    const { ImportResolver } = await import("./graph/resolve.js");
    const resolver = await ImportResolver.create(source.root, files, manifests);

    const result = buildGraph({
      files,
      parsed,
      resolver,
      churn: churn.counts,
      churnAvailable: churn.available,
      weights: options.weights,
      parseFailures,
    });

    const graph: RepoGraph = {
      version: 2,
      source: source.source,
      generatedAt: new Date().toISOString(),
      stats: result.stats,
      nodes: result.nodes,
      edges: result.edges,
      functionNodes: result.functionNodes,
      functionEdges: result.functionEdges,
      parseFailures,
    };

    // Summarisation mutates the graph in place, so it must run before the caller writes
    // it out — and while the clone still exists, since it reads the files from disk.
    if (!options.skipSummarize && options.cacheDir) {
      onProgress("Summarising …");
      graph.summarization = await summarizeGraph(graph, {
        root: source.root,
        cacheDir: options.cacheDir,
        topN: options.summarizeTop,
        provider: options.provider,
        model: options.model,
        baseUrl: options.ollamaUrl,
        backend: options.summarizeBackend,
        onProgress,
      });
    }

    return graph;
  } finally {
    await source.cleanup();
  }
}

/** Writes a graph to `<outDir>/graph.json` and returns the path written. */
export async function writeGraph(graph: RepoGraph, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, "graph.json");
  await writeFile(target, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return target;
}
