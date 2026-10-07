import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EMBED_MODEL } from "../llm/ollama.js";
import type { Chunk } from "./chunk.js";

export const INDEX_FILENAME = "embeddings.json";
export const VECTORS_FILENAME = "embeddings.bin";

/**
 * Each embedding model gets its own pair of files, so switching the explorer between
 * local and Gemini doesn't wipe the other index and re-embed everything. The default
 * local model keeps the old file names so existing indexes still load.
 */
export function indexFiles(model: string): { manifest: string; vectors: string } {
  if (model === DEFAULT_EMBED_MODEL) return { manifest: INDEX_FILENAME, vectors: VECTORS_FILENAME };
  const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
  return { manifest: `embeddings-${slug}.json`, vectors: `embeddings-${slug}.bin` };
}

/** A stored chunk plus its vector. */
export interface StoredChunk extends Chunk {
  /** Model that made the vector. If it changes, the entry is stale. */
  model: string;
}

export interface SearchHit {
  chunk: StoredChunk;
  /** Cosine similarity, -1..1. 1 means identical. */
  score: number;
}

export interface SearchOptions {
  /**
   * Give each chunk kind half the result slots.
   *
   * File chunks have a path, a summary, the full declaration list and graph metrics, so
   * they're a fair bit longer than function chunks. That makes them score okay against
   * pretty much any query, and with one global ranking they push out the shorter function
   * chunks that hold the specific answer. Reserving slots per kind keeps the detailed
   * chunks in.
   */
  balanceKinds?: boolean;
}

/**
 * What the RAG code relies on. Brute-force cosine is the only implementation right now;
 * an ANN store could plug in here without changing anything else.
 */
export interface VectorStore {
  readonly size: number;
  readonly dim: number;
  /** Vector for a chunk whose text and model haven't changed, if we have one. */
  reusable(chunk: Chunk, model: string): Float32Array | undefined;
  /** Replace everything with this set. */
  replace(entries: Array<{ chunk: StoredChunk; vector: Float32Array }>): void;
  search(query: Float32Array, k: number, options?: SearchOptions): SearchHit[];
  save(): Promise<void>;
}

/** Most similar first, file importance breaks exact ties. */
function byRelevance(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || b.chunk.importance - a.chunk.importance;
}

/** Scale a vector to unit length so the dot product is cosine similarity. */
export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let sumSquares = 0;
  for (let i = 0; i < values.length; i++) sumSquares += values[i]! * values[i]!;

  // A zero vector has no direction. Leave it at zero instead of dividing by zero.
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return out;

  for (let i = 0; i < values.length; i++) out[i] = values[i]! / norm;
  return out;
}

interface IndexManifest {
  version: 1;
  model: string;
  dim: number;
  entries: StoredChunk[];
}

/**
 * All vectors sit in one flat Float32Array and search is a plain dot product over all of
 * them.
 *
 * That's on purpose. We index one chunk per file plus a few per summarised file, so even
 * a big repo ends up in the low tens of thousands of chunks. Measured: about 6ms per
 * query at 5,000 chunks, 60ms at 50,000. An ANN index would mean a native dependency to
 * save time we're not actually spending.
 */
export class BruteForceStore implements VectorStore {
  private constructor(
    private readonly dir: string,
    private model: string,
    private dimension: number,
    private chunks: StoredChunk[],
    /** All vectors back to back: chunk i sits at [i*dim, (i+1)*dim). */
    private vectors: Float32Array,
  ) {}

  static empty(dir: string, model: string): BruteForceStore {
    return new BruteForceStore(dir, model, 0, [], new Float32Array(0));
  }

  /** Load an existing index. Anything unreadable or stale counts as empty. */
  static async load(dir: string, model: string): Promise<BruteForceStore> {
    const files = indexFiles(model);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(dir, files.manifest), "utf8"),
      ) as IndexManifest;

      if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
        return BruteForceStore.empty(dir, model);
      }

      const raw = await readFile(path.join(dir, files.vectors));
      const expected = manifest.entries.length * manifest.dim;
      const vectors = new Float32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      );

      // If the manifest and the vector file disagree, don't trust either.
      if (vectors.length !== expected) return BruteForceStore.empty(dir, model);

      return new BruteForceStore(dir, manifest.model, manifest.dim, manifest.entries, vectors);
    } catch {
      return BruteForceStore.empty(dir, model);
    }
  }

  get size(): number {
    return this.chunks.length;
  }

  get dim(): number {
    return this.dimension;
  }

  reusable(chunk: Chunk, model: string): Float32Array | undefined {
    if (model !== this.model) return undefined;

    const position = this.chunks.findIndex((c) => c.id === chunk.id && c.hash === chunk.hash);
    if (position === -1) return undefined;

    return this.vectors.subarray(position * this.dimension, (position + 1) * this.dimension);
  }

  replace(entries: Array<{ chunk: StoredChunk; vector: Float32Array }>): void {
    this.dimension = entries[0]?.vector.length ?? 0;
    this.chunks = entries.map((e) => e.chunk);
    this.model = entries[0]?.chunk.model ?? this.model;

    this.vectors = new Float32Array(entries.length * this.dimension);
    for (let i = 0; i < entries.length; i++) {
      this.vectors.set(entries[i]!.vector, i * this.dimension);
    }
  }

  /**
   * Brute-force cosine search. Vectors are stored at unit length, so the dot product
   * already is the similarity.
   *
   * With `balanceKinds`, each kind gets at least floor(k/2) slots, and leftover slots go
   * to the best remaining chunks of any kind. That still works when one kind is rare, or
   * k is odd or 1.
   */
  search(query: Float32Array, k: number, options: SearchOptions = {}): SearchHit[] {
    if (this.chunks.length === 0 || this.dimension === 0) return [];
    if (query.length !== this.dimension) {
      throw new Error(
        `Query has ${query.length} dimensions but the index has ${this.dimension}. ` +
          "Re-run `synapse index` after changing --embed-model.",
      );
    }

    const scored: SearchHit[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const offset = i * this.dimension;
      let dot = 0;
      for (let d = 0; d < this.dimension; d++) dot += this.vectors[offset + d]! * query[d]!;
      scored.push({ chunk: this.chunks[i]!, score: dot });
    }

    scored.sort(byRelevance);

    const limit = Math.max(0, k);
    if (!options.balanceKinds) return scored.slice(0, limit);

    const perKind = Math.floor(limit / 2);
    const claimed = new Set<number>();
    const picked: SearchHit[] = [];

    for (const kind of ["file", "function"] as const) {
      let count = 0;
      for (let i = 0; i < scored.length && count < perKind; i++) {
        if (claimed.has(i) || scored[i]!.chunk.kind !== kind) continue;
        claimed.add(i);
        picked.push(scored[i]!);
        count++;
      }
    }

    // Leftover slots go to the best chunks not picked yet, any kind.
    for (let i = 0; i < scored.length && picked.length < limit; i++) {
      if (claimed.has(i)) continue;
      claimed.add(i);
      picked.push(scored[i]!);
    }

    picked.sort(byRelevance);
    return picked;
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const manifest: IndexManifest = {
      version: 1,
      model: this.model,
      dim: this.dimension,
      entries: this.chunks,
    };

    const files = indexFiles(this.model);
    await writeFile(path.join(this.dir, files.manifest), `${JSON.stringify(manifest)}\n`, "utf8");
    await writeFile(path.join(this.dir, files.vectors), Buffer.from(this.vectors.buffer));
  }

  /** Delete both files. For tests, or to force a clean rebuild. */
  async clear(): Promise<void> {
    const files = indexFiles(this.model);
    await rm(path.join(this.dir, files.manifest), { force: true });
    await rm(path.join(this.dir, files.vectors), { force: true });
  }
}
