import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_MODEL,
  OllamaClient,
  type OllamaConfig,
  type Preflight,
} from "../summarize/ollama.js";
import type { RepoGraph } from "../types.js";
import { buildIndex, loadIndex, type EmbeddingBackend } from "./index.js";
import { normalizeVector, type SearchHit } from "./store.js";

export const DEFAULT_TOP_K = 8;

/** The slice of OllamaClient answering needs, so tests can substitute a fake. */
export interface ChatBackend {
  readonly model: string;
  preflight(model?: string): Promise<Preflight>;
  generateText(prompt: string, options?: { numPredict?: number }): Promise<string>;
}

/** A chunk the answer drew on, for --show-sources. */
export interface Source {
  kind: "file" | "function";
  path: string;
  ref?: string;
  startLine?: number;
  score: number;
}

export interface AskOptions extends OllamaConfig {
  /** Where the index lives. */
  cacheDir: string;
  /** Repo root, needed only if the index has to be built on demand. */
  root?: string;
  /** Graph to index from, if the index is missing or stale. */
  graph?: RepoGraph;
  embedModel?: string;
  topK?: number;
  embedBackend?: EmbeddingBackend;
  chatBackend?: ChatBackend;
  onProgress?: (message: string) => void;
}

export interface AskResult {
  ok: boolean;
  question: string;
  answer: string;
  sources: Source[];
  /** Set when the question could not be answered, with remediation. */
  message?: string;
}

/**
 * Assembles the answering prompt. Retrieved chunks are laid out newest-first by
 * relevance and labelled with their source, so the model can cite what it used and the
 * reader can check it.
 */
export function buildAnswerPrompt(question: string, hits: SearchHit[]): string {
  const lines: string[] = [
    "You are answering a question about a specific codebase.",
    "Below are excerpts retrieved from an analysis of that codebase: file summaries,",
    "declaration lists, dependency-graph metrics, and per-function summaries.",
    "",
    "=== RETRIEVED CONTEXT ===",
    "",
  ];

  hits.forEach((hit, i) => {
    const label = hit.chunk.kind === "function" ? `${hit.chunk.ref} in ${hit.chunk.path}` : hit.chunk.path;
    lines.push(`--- [${i + 1}] ${label} (relevance ${hit.score.toFixed(3)}) ---`, hit.chunk.text, "");
  });

  lines.push(
    "=== END CONTEXT ===",
    "",
    `Question: ${question}`,
    "",
    "Answer using only the context above. Refer to files and functions by name so the",
    "reader can find them. If the context does not contain enough to answer, say so",
    "plainly and name what is missing rather than guessing.",
  );

  return lines.join("\n");
}

/**
 * Answers a question by retrieving the most similar chunks and asking the chat model
 * over them.
 *
 * Builds the index on demand when one is missing, so a first `ask` works without
 * running `index` first. Returns a result with `ok: false` and remediation instead of
 * throwing, matching how summarisation degrades.
 */
export async function ask(question: string, options: AskOptions): Promise<AskResult> {
  const { cacheDir, topK = DEFAULT_TOP_K, onProgress = () => {} } = options;
  const embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;

  const client = new OllamaClient(options);
  const embedBackend: EmbeddingBackend = options.embedBackend ?? client;
  const chatBackend: ChatBackend = options.chatBackend ?? client;

  const fail = (message: string): AskResult => ({
    ok: false,
    question,
    answer: "",
    sources: [],
    message,
  });

  // Both models must be present; checking up front avoids embedding work that the
  // answering step would only throw away.
  const embedReady = await embedBackend.preflight(embedModel);
  if (!embedReady.ok) return fail(embedReady.message);

  const chatReady = await chatBackend.preflight(chatBackend.model ?? DEFAULT_MODEL);
  if (!chatReady.ok) return fail(chatReady.message);

  let store = await loadIndex(cacheDir, embedModel);

  if (store.size === 0) {
    if (!options.graph) {
      return fail(
        "No embedding index found and no graph to build one from.\n" +
          "  Run `synapse analyze <path>` first, then `synapse index`.",
      );
    }

    onProgress("No index found — building one now …");
    const report = await buildIndex(options.graph, {
      ...options,
      cacheDir,
      embedModel,
      backend: embedBackend,
      onProgress,
    });

    if (!report.ran) return fail(report.message ?? "Could not build the embedding index.");
    store = await loadIndex(cacheDir, embedModel);
  }

  let queryVector: Float32Array;
  try {
    const [vector] = await embedBackend.embed([question], embedModel);
    if (!vector) return fail("The embedding model returned nothing for the question.");
    queryVector = normalizeVector(vector);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let hits: SearchHit[];
  try {
    hits = store.search(queryVector, topK);
  } catch (error) {
    // Dimension mismatch: the index was built with a different embedding model.
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (hits.length === 0) {
    return fail("The index is empty. Run `synapse index` to build it.");
  }

  onProgress(`Retrieved ${hits.length} chunks; asking ${chatBackend.model} …`);

  let answer: string;
  try {
    answer = await chatBackend.generateText(buildAnswerPrompt(question, hits));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  return {
    ok: true,
    question,
    answer,
    sources: hits.map((hit) => ({
      kind: hit.chunk.kind,
      path: hit.chunk.path,
      ref: hit.chunk.ref,
      startLine: hit.chunk.startLine,
      score: Math.round(hit.score * 10_000) / 10_000,
    })),
  };
}
