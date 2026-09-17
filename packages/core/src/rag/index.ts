import { DEFAULT_EMBED_MODEL, OllamaClient, type OllamaConfig, type Preflight } from "../summarize/ollama.js";
import type { RepoGraph } from "../types.js";
import { buildChunks, type Chunk } from "./chunk.js";
import { BruteForceStore, normalizeVector, type StoredChunk, type VectorStore } from "./store.js";

export { buildChunks, chunkHash, type Chunk } from "./chunk.js";
export {
  BruteForceStore,
  normalizeVector,
  INDEX_FILENAME,
  VECTORS_FILENAME,
  type VectorStore,
  type SearchHit,
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

/** The slice of OllamaClient the indexer needs, so tests can substitute a fake. */
export interface EmbeddingBackend {
  preflight(model?: string): Promise<Preflight>;
  embed(texts: string[], model: string): Promise<number[][]>;
}

/** How many chunks to send per embedding request. */
const EMBED_BATCH = 16;

export interface IndexOptions extends OllamaConfig {
  /** Repo root, used to recover real function signatures for chunks. */
  root?: string;
  /** Where embeddings.json and embeddings.bin live. */
  cacheDir: string;
  /** Embedding model; must be one built for embeddings, not a chat model. */
  embedModel?: string;
  backend?: EmbeddingBackend;
  onProgress?: (message: string) => void;
}

export interface IndexReport {
  /** False when the index could not be built; `message` says why. */
  ran: boolean;
  embedModel: string;
  /** Chunks in the index after this run. */
  total: number;
  /** Chunks embedded fresh this run. */
  embedded: number;
  /** Chunks whose vectors were reused because their text had not changed. */
  reused: number;
  /** Vector dimensionality, once known. */
  dim: number;
  message?: string;
}

/**
 * Builds or refreshes the embedding index for a graph.
 *
 * Chunks are keyed by a SHA-256 of their own text, exactly as summaries are keyed by a
 * hash of their file, so a re-run only embeds what actually changed. Changing the
 * embedding model invalidates everything, since vectors from two models are not
 * comparable.
 *
 * Never throws for an unavailable Ollama or a model that cannot embed: those come back
 * as a report with `ran: false` and remediation.
 */
export async function buildIndex(graph: RepoGraph, options: IndexOptions): Promise<IndexReport> {
  const { cacheDir, root, onProgress = () => {} } = options;
  const embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;
  const backend: EmbeddingBackend = options.backend ?? new OllamaClient(options);

  const base: IndexReport = { ran: false, embedModel, total: 0, embedded: 0, reused: 0, dim: 0 };

  const preflight = await backend.preflight(embedModel);
  if (!preflight.ok) return { ...base, message: preflight.message };

  const chunks = await buildChunks(graph, root);
  if (chunks.length === 0) {
    return { ...base, ran: true, message: "Nothing to index — the graph has no files." };
  }

  const store = await BruteForceStore.load(cacheDir, embedModel);

  // Reuse what we can before deciding what to send to the model.
  const entries: Array<{ chunk: StoredChunk; vector: Float32Array }> = [];
  const pending: Chunk[] = [];
  const pendingIndex: number[] = [];

  for (const chunk of chunks) {
    const stored: StoredChunk = { ...chunk, model: embedModel };
    const existing = store.reusable(chunk, embedModel);

    if (existing) {
      // Copy: the subarray views a buffer that `replace` is about to discard.
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

/** Loads an index without rebuilding it, for answering against what is already there. */
export async function loadIndex(cacheDir: string, embedModel: string): Promise<VectorStore> {
  return BruteForceStore.load(cacheDir, embedModel);
}
