import { createEmbeddingProvider, defaultEmbedModelFor, type ProviderOptions } from "../llm/provider.js";
import type { Preflight } from "../llm/types.js";
import type { RepoGraph } from "../types.js";
import { buildChunks, type Chunk } from "./chunk.js";
import { BruteForceStore, normalizeVector, type StoredChunk, type VectorStore } from "./store.js";

export { buildChunks, chunkHash, type Chunk } from "./chunk.js";
export {
  BruteForceStore,
  normalizeVector,
  INDEX_FILENAME,
  VECTORS_FILENAME,
  indexFiles,
  type VectorStore,
  type SearchHit,
  type SearchOptions,
  type StoredChunk,
} from "./store.js";
export {
  ask,
  buildAnswerPrompt,
  DEFAULT_TOP_K,
  type AskOptions,
  type AskResult,
  type Source,
  type ChatBackend,
} from "./ask.js";

/**
 * The part of LlmProvider that indexing needs. Any provider with embeddings fits; one
 * without them fails preflight before it ever gets here.
 */
export interface EmbeddingBackend {
  preflight(model?: string): Promise<Preflight>;
  embed(texts: string[], model: string): Promise<number[][]>;
}

/** Chunks per embedding request. */
const EMBED_BATCH = 16;

export interface IndexOptions extends ProviderOptions {
  /** Repo root, used to get real function signatures for chunks. */
  root?: string;
  /** Where embeddings.json and embeddings.bin live. */
  cacheDir: string;
  /** Embedding model. Has to be an actual embedding model, not a chat one. */
  embedModel?: string;
  backend?: EmbeddingBackend;
  onProgress?: (message: string) => void;
}

export interface IndexReport {
  /** False if we couldn't build the index. `message` says why. */
  ran: boolean;
  embedModel: string;
  /** Chunks in the index after this run. */
  total: number;
  /** Chunks embedded fresh this time. */
  embedded: number;
  /** Chunks whose vectors we reused because the text didn't change. */
  reused: number;
  /** Vector size, once we know it. */
  dim: number;
  message?: string;
}

/**
 * Build or refresh the embedding index for a graph.
 *
 * Chunks are keyed by a SHA-256 of their text (summaries work the same way with file
 * hashes), so a re-run only embeds what changed. Switching embedding models throws
 * everything out, since vectors from two models can't be compared.
 *
 * Doesn't throw if Ollama is down or the model can't embed. You get a report with
 * `ran: false` and what to do.
 */
export async function buildIndex(graph: RepoGraph, options: IndexOptions): Promise<IndexReport> {
  const { cacheDir, root, onProgress = () => {} } = options;
  const embedModel = options.embedModel ?? defaultEmbedModelFor(options.provider);
  const backend: EmbeddingBackend = options.backend ?? createEmbeddingProvider(options);

  const base: IndexReport = { ran: false, embedModel, total: 0, embedded: 0, reused: 0, dim: 0 };

  const preflight = await backend.preflight(embedModel);
  if (!preflight.ok) return { ...base, message: preflight.message };

  const chunks = await buildChunks(graph, root);
  if (chunks.length === 0) {
    return { ...base, ran: true, message: "Nothing to index — the graph has no files." };
  }

  const store = await BruteForceStore.load(cacheDir, embedModel);

  // Reuse whatever we can before working out what to send to the model.
  const entries: Array<{ chunk: StoredChunk; vector: Float32Array }> = [];
  const pending: Chunk[] = [];
  const pendingIndex: number[] = [];

  for (const chunk of chunks) {
    const stored: StoredChunk = { ...chunk, model: embedModel };
    const existing = store.reusable(chunk, embedModel);

    if (existing) {
      // Copy it: the subarray points into a buffer `replace` is about to throw away.
      entries.push({ chunk: stored, vector: new Float32Array(existing) });
    } else {
      pendingIndex.push(entries.length);
      entries.push({ chunk: stored, vector: new Float32Array(0) });
      pending.push(chunk);
    }
  }

  const reused = chunks.length - pending.length;
  onProgress(`${chunks.length} chunks — ${reused} cached, ${pending.length} to embed.`);

  try {
    for (let offset = 0; offset < pending.length; offset += EMBED_BATCH) {
      const batch = pending.slice(offset, offset + EMBED_BATCH);
      const vectors = await backend.embed(batch.map((c) => c.text), embedModel);

      if (vectors.length !== batch.length) {
        throw new Error(`Expected ${batch.length} embeddings, got ${vectors.length}`);
      }

      for (let i = 0; i < batch.length; i++) {
        entries[pendingIndex[offset + i]!]!.vector = normalizeVector(vectors[i]!);
      }

      onProgress(`  embedded ${Math.min(offset + batch.length, pending.length)}/${pending.length}`);
    }
  } catch (error) {
    return {
      ...base,
      reused,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const dim = entries[0]?.vector.length ?? 0;
  if (dim === 0 || entries.some((e) => e.vector.length !== dim)) {
    return { ...base, reused, message: "The embedding model returned inconsistent vector sizes." };
  }

  store.replace(entries);
  await store.save();

  return {
    ran: true,
    embedModel,
    total: entries.length,
    embedded: pending.length,
    reused,
    dim,
  };
}

/** Load an index without rebuilding it, to answer from what's already there. */
export async function loadIndex(cacheDir: string, embedModel: string): Promise<VectorStore> {
  return BruteForceStore.load(cacheDir, embedModel);
}
