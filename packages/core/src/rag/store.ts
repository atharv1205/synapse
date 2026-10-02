import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EMBED_MODEL } from "../llm/ollama.js";
import type { Chunk } from "./chunk.js";

export const INDEX_FILENAME = "embeddings.json";
export const VECTORS_FILENAME = "embeddings.bin";

/**
 * Each embedding model keeps its own pair of files, so switching the explorer between the
 * local model and Gemini does not throw away the other's index and re-embed everything.
 * The default local model keeps the original names, so indexes built before this load.
 */
export function indexFiles(model: string): { manifest: string; vectors: string } {
  if (model === DEFAULT_EMBED_MODEL) return { manifest: INDEX_FILENAME, vectors: VECTORS_FILENAME };
  const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
  return { manifest: `embeddings-${slug}.json`, vectors: `embeddings-${slug}.bin` };
}

/** A stored chunk plus the vector it embedded to. */
export interface StoredChunk extends Chunk {
  /** Model that produced the vector; a change invalidates the entry. */
  model: string;
}

export interface SearchHit {
  chunk: StoredChunk;
  /** Cosine similarity in -1..1; 1 is identical. */
  score: number;
}

export interface SearchOptions {
  /**
   * Reserve half the results for each chunk kind.
   *
   * File chunks carry a path, a summary, a full declaration list and graph metrics, so
   * they average noticeably more text than function chunks. That breadth makes them
   * score moderately well against almost any query, and on a purely global ranking they
   * crowd out the shorter function chunks that hold the specific answer. Reserving
   * seats per kind keeps fine-grained chunks in the results.
   */
  balanceKinds?: boolean;
}

/**
 * The contract the RAG pass depends on. Brute-force cosine is the only implementation
 * today; an ANN-backed store would slot in here without touching anything upstream.
 */
export interface VectorStore {
  readonly size: number;
  readonly dim: number;
  /** Vector for a chunk whose text and model are unchanged, if one is held. */
  reusable(chunk: Chunk, model: string): Float32Array | undefined;
  /** Replaces the contents wholesale with this set. */
  replace(entries: Array<{ chunk: StoredChunk; vector: Float32Array }>): void;
  search(query: Float32Array, k: number, options?: SearchOptions): SearchHit[];
  save(): Promise<void>;
}

/** Most similar first, with file importance breaking exact ties. */
function byRelevance(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || b.chunk.importance - a.chunk.importance;
}

/** Scales a vector to unit length so a dot product is cosine similarity. */
export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let sumSquares = 0;
  for (let i = 0; i < values.length; i++) sumSquares += values[i]! * values[i]!;

  // A zero vector has no direction; leave it at zero rather than dividing by zero.
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
 * Vectors live in one flat Float32Array and searches are an exhaustive dot product.
 *
 * That is deliberate. Synapse indexes one chunk per file plus a few per summarised
 * file, so a large repo lands in the low tens of thousands of chunks — measured at
 * roughly 6ms per query at 5,000 chunks and 60ms at 50,000. An ANN index would add a
 * native dependency to save time that is not being spent.
 */
export class BruteForceStore implements VectorStore {
  private constructor(
    private readonly dir: string,
    private model: string,
    private dimension: number,
    private chunks: StoredChunk[],
    /** All vectors concatenated: chunk i occupies [i*dim, (i+1)*dim). */
    private vectors: Float32Array,
  ) {}

  static empty(dir: string, model: string): BruteForceStore {
    return new BruteForceStore(dir, model, 0, [], new Float32Array(0));
  }

  /** Loads an existing index, treating anything unreadable or stale as empty. */
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

      // A manifest that disagrees with its vector file cannot be trusted.
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
   * Exhaustive cosine search. Vectors are stored unit-length, so the dot product is
   * the similarity and no per-comparison normalisation is needed.
   *
   * With `balanceKinds`, each kind is guaranteed floor(k/2) seats and any remaining
   * seats go to the best unclaimed chunks regardless of kind. That keeps the behaviour
   * sensible when one kind is scarce, or when k is odd or 1.
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

    // Whatever is left over goes to the best chunks still unclaimed, whatever their kind.
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

  /** Removes both files, for tests and for forcing a clean rebuild. */
  async clear(): Promise<void> {
    const files = indexFiles(this.model);
    await rm(path.join(this.dir, files.manifest), { force: true });
    await rm(path.join(this.dir, files.vectors), { force: true });
  }
}
