import { createProviders, defaultEmbedModelFor, type ProviderOptions } from "../llm/provider.js";
import type { Preflight } from "../llm/types.js";
import type { RepoGraph } from "../types.js";
import { buildIndex, loadIndex, type EmbeddingBackend } from "./index.js";
import { normalizeVector, type SearchHit } from "./store.js";

export const DEFAULT_TOP_K = 8;

/**
 * The slice of LlmProvider that answering needs. Narrower than the full interface on
 * purpose: any provider satisfies it, and a test fake only has to implement three
 * methods instead of the whole surface.
 */
export interface ChatBackend {
  readonly model: string;
  preflight(model?: string): Promise<Preflight>;
  generateText(prompt: string, options?: { maxTokens?: number }): Promise<string>;
}

/** A chunk the answer drew on, for --show-sources. */
export interface Source {
  kind: "file" | "function";
  path: string;
  ref?: string;
  startLine?: number;
  score: number;
}

export interface AskOptions extends ProviderOptions {
  /** Where the index lives. */
  cacheDir: string;
  /** Repo root, needed only if the index has to be built on demand. */
  root?: string;
  /** Graph to index from, if the index is missing or stale. */
  graph?: RepoGraph;
  embedModel?: string;
  topK?: number;
  /**
   * Rank purely by similarity instead of reserving seats per chunk kind. Off by
   * default: a global ranking lets the longer file chunks crowd out the function
   * chunks that usually hold the specific answer.
   */
  globalRank?: boolean;
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
  /** Which backend produced the answer, and which produced the vectors. */
  providers?: { chat: string; chatModel: string; embed: string; embedModel: string };
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
  const embedModel = options.embedModel ?? defaultEmbedModelFor(options.provider);

  const providers = createProviders(options);
  const embedBackend: EmbeddingBackend = options.embedBackend ?? providers.embed;
  const chatBackend: ChatBackend = options.chatBackend ?? providers.chat;

  const fail = (message: string): AskResult => ({
    ok: false,
    question,
    answer: "",
    sources: [],
    message,
  });

  // Both backends must be ready; checking up front avoids embedding work that the
  // answering step would only throw away.
  //
  // When chat and embeddings come from different providers, an embedding failure is
  // confusing on its own — the user asked for Anthropic and is being told about
  // Ollama — so the reason the two differ is attached to the message.
  const embedReady = await embedBackend.preflight(embedModel);
  if (!embedReady.ok) {
    return fail(
      providers.embedNote
        ? `${embedReady.message}\n\n  ${providers.embedNote}`
        : embedReady.message,
    );
  }

  const chatReady = await chatBackend.preflight(chatBackend.model);
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
    hits = store.search(queryVector, topK, { balanceKinds: options.globalRank !== true });
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
    providers: {
      chat: providers.chat.name,
      chatModel: chatBackend.model,
      embed: providers.embed.name,
      embedModel,
    },
    sources: hits.map((hit) => ({
      kind: hit.chunk.kind,
      path: hit.chunk.path,
      ref: hit.chunk.ref,
      startLine: hit.chunk.startLine,
      score: Math.round(hit.score * 10_000) / 10_000,
    })),
  };
}
