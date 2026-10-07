import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchRepositoryInfo, gitHubRepoOf, parseGitHubRepo, type RepositoryLookup } from "./ingest/github.js";
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
   * Token for cloning a private repo. It only goes to the clone step and is never stored;
   * the graph keeps the redacted URL.
   */
  token?: string;
  /** Centrality vs churn mix. 70/30 by default. */
  weights?: ScoreWeights;
  /** Skip reading git history. */
  skipChurn?: boolean;
  /** Skip LLM summaries completely. */
  skipSummarize?: boolean;
  /** Who writes the summaries: local Ollama, Gemini or Claude. */
  provider?: ProviderName;
  /** Chat model. Falls back to the provider's default. */
  model?: string;
  /** Ollama base URL, if it's not the usual local one. */
  ollamaUrl?: string;
  /** How many of the top files to summarise. */
  summarizeTop?: number;
  /**
   * Where summaries.json lives. No cacheDir means no summaries, since there'd be nowhere
   * to cache them.
   */
  cacheDir?: string;
  /** Tests pass a fake here so they never hit a real model. */
  summarizeBackend?: SummarizerBackend;
  /** Don't ask GitHub for the repo's description, stars and language. */
  skipGitHub?: boolean;
  /** Stand-in for fetch in the GitHub lookup, so tests stay offline. */
  githubFetch?: typeof fetch;
  onProgress?: (message: string) => void;
}

/** The whole pipeline: walk, parse, resolve, score. Doesn't write anything to disk. */
export async function analyze(target: string, options: AnalyzeOptions = {}): Promise<RepoGraph> {
  const { onProgress = () => {} } = options;
  const source = await resolveSource(target, {
    depth: options.depth,
    token: options.token,
    onProgress,
  });

  try {
    // Fetch the GitHub details while we parse, not before, so they cost no extra time. A
    // URL tells us the repo directly; for a local folder we look for a GitHub origin
    // remote.
    const details: Promise<RepositoryLookup | undefined> = options.skipGitHub
      ? Promise.resolve(undefined)
      : (async () => {
          const repo = parseGitHubRepo(target) ?? (await gitHubRepoOf(source.root));
          if (!repo) return undefined;
          return fetchRepositoryInfo(repo, { token: options.token, fetch: options.githubFetch });
        })();

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
        // If a file can't be read or parsed it drops out of the graph, but we record it
        // instead of swallowing the error. A silent gap here loses that file's imports
        // and symbols and skews every score. That's exactly how the 32KB parser limit
        // went unnoticed.
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

    const lookup = await details;
    if (lookup?.ok) {
      graph.repository = lookup.info;
      onProgress(`GitHub: ${lookup.info.fullName}${lookup.info.stars !== undefined ? `, ${lookup.info.stars.toLocaleString("en-US")} stars` : ""}.`);
    } else if (lookup) {
      onProgress(lookup.reason);
    }

    // Summarising edits the graph in place, so it has to happen before the caller writes
    // it out. It also reads files from disk, so the clone needs to still be around.
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

/** Write the graph to `<outDir>/graph.json` and return that path. */
export async function writeGraph(graph: RepoGraph, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, "graph.json");
  await writeFile(target, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return target;
}
