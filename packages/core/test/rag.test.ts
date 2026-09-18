import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { buildChunks, chunkHash } from "../src/rag/chunk.js";
import { buildIndex, loadIndex, type EmbeddingBackend } from "../src/rag/index.js";
import { ask, buildAnswerPrompt, type ChatBackend } from "../src/rag/ask.js";
import { BruteForceStore, normalizeVector, type StoredChunk } from "../src/rag/store.js";
import type { Preflight } from "../src/llm/ollama.js";
import type { RepoGraph } from "../src/types.js";
import { createFixture, type Fixture } from "./fixture.js";

/**
 * A deterministic stand-in for a real embedding model: a bag-of-words vector over a
 * fixed vocabulary. Texts that share vocabulary land near each other, so retrieval
 * tests exercise real cosine similarity without any model or network.
 */
const VOCAB = [
  "registry",
  "helper",
  "python",
  "accumulator",
  "orphan",
  "import",
  "boot",
  "double",
] as const;

export function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => {
    const matches = lower.split(term).length - 1;
    return matches;
  });
}

class FakeEmbedder implements EmbeddingBackend {
  readonly texts: string[] = [];
  calls = 0;

  constructor(
    private readonly behaviour: {
      preflight?: Preflight;
      throws?: string;
      /** Returns vectors of the wrong width, to exercise the consistency check. */
      ragged?: boolean;
    } = {},
  ) {}

  async preflight(): Promise<Preflight> {
    return this.behaviour.preflight ?? { ok: true };
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts.push(...texts);
    if (this.behaviour.throws) throw new Error(this.behaviour.throws);
    if (this.behaviour.ragged) return texts.map((_, i) => new Array(i === 0 ? 4 : 8).fill(1));
    return texts.map(fakeVector);
  }
}

class FakeChat implements ChatBackend {
  readonly model = "fake-chat";
  readonly prompts: string[] = [];

  constructor(private readonly behaviour: { preflight?: Preflight; throws?: string } = {}) {}

  async preflight(): Promise<Preflight> {
    return this.behaviour.preflight ?? { ok: true };
  }

  async generateText(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.behaviour.throws) throw new Error(this.behaviour.throws);
    return "The Registry class in hub.ts accumulates values.";
  }
}

/** A graph with summaries filled in, so function chunks exist to retrieve. */
async function summarisedGraph(root: string): Promise<RepoGraph> {
  const graph = await analyze(root, { skipSummarize: true });

  for (const node of graph.nodes) {
    node.summary = `Summary for ${node.path}.`;
  }

  const hub = graph.nodes.find((n) => n.path === "hub.ts");
  for (const fn of hub?.functions ?? []) {
    fn.summary = `${fn.qualifiedName} does something with the registry helper.`;
    const twin = graph.functionNodes.find((f) => f.id === fn.id);
    if (twin) twin.summary = fn.summary;
  }

  return graph;
}

describe("normalizeVector", () => {
  it("scales to unit length so a dot product is cosine similarity", () => {
    const v = normalizeVector([3, 4]);
    assert.ok(Math.abs(Math.hypot(v[0]!, v[1]!) - 1) < 1e-6);
    assert.ok(Math.abs(v[0]! - 0.6) < 1e-6);
  });

  it("leaves a zero vector at zero rather than dividing by zero", () => {
    const v = normalizeVector([0, 0, 0]);
    assert.deepEqual([...v], [0, 0, 0]);
  });
});

describe("chunking", () => {
  let fixture: Fixture;
  let graph: RepoGraph;
  let chunks: Awaited<ReturnType<typeof buildChunks>>;

  before(async () => {
    fixture = await createFixture();
    graph = await summarisedGraph(fixture.root);
    chunks = await buildChunks(graph, fixture.root);
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("emits one chunk per file", () => {
    const fileChunks = chunks.filter((c) => c.kind === "file");
    assert.equal(fileChunks.length, graph.nodes.length);
    assert.ok(fileChunks.every((c) => c.id.startsWith("file:")));
  });

  it("puts the path, summary, metrics and declarations in the file chunk", () => {
    const hub = chunks.find((c) => c.id === "file:hub.ts");
    assert.ok(hub);
    assert.match(hub.text, /File: hub\.ts/);
    assert.match(hub.text, /Summary for hub\.ts/);
    assert.match(hub.text, /imported by 3 file\(s\)/);
    assert.match(hub.text, /- class Registry \(exported\)/);
    assert.match(hub.text, /- function sharedHelper \(exported\)/);
  });

  it("emits a chunk only for functions that were individually summarised", () => {
    const fnChunks = chunks.filter((c) => c.kind === "function");
    assert.ok(fnChunks.length > 0);
    assert.ok(
      fnChunks.every((c) => c.path === "hub.ts"),
      "only hub.ts functions were given summaries",
    );
  });

  it("puts the signature, file, summary and outgoing calls in the function chunk", () => {
    const chunk = chunks.find((c) => c.id === "fn:hub.ts#Registry.total");
    assert.ok(chunk, "Registry.total should have a chunk");
    assert.match(chunk.text, /Function: Registry\.total/);
    assert.match(chunk.text, /In file: hub\.ts \(line \d+\)/);
    assert.match(chunk.text, /Signature: total\(\): number/);
    assert.match(chunk.text, /Calls: sharedHelper/);
  });

  it("notes when a function resolves no outgoing calls", () => {
    const chunk = chunks.find((c) => c.id === "fn:hub.ts#sharedHelper");
    assert.match(chunk!.text, /Calls no other functions/);
  });

  it("falls back to a graph-derived signature when the source cannot be read", async () => {
    const detached = await buildChunks(graph);
    const chunk = detached.find((c) => c.id === "fn:hub.ts#sharedHelper");
    assert.match(chunk!.text, /Signature: function sharedHelper/);
  });

  it("hashes the chunk text, so changed text is a different key", () => {
    assert.equal(chunkHash("abc"), chunkHash("abc"));
    assert.notEqual(chunkHash("abc"), chunkHash("abd"));
    assert.ok(chunks.every((c) => c.hash === chunkHash(c.text)));
  });
});

describe("BruteForceStore", () => {
  let fixture: Fixture;
  let dir: string;

  const chunk = (id: string, text: string): StoredChunk => ({
    id,
    kind: "file",
    path: id,
    importance: 0.5,
    text,
    hash: chunkHash(text),
    model: "fake-embed",
  });

  before(async () => {
    fixture = await createFixture();
    dir = path.join(fixture.root, ".index");
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("ranks by cosine similarity", () => {
    const store = BruteForceStore.empty(dir, "fake-embed");
    store.replace([
      { chunk: chunk("a", "registry registry"), vector: normalizeVector(fakeVector("registry registry")) },
      { chunk: chunk("b", "python accumulator"), vector: normalizeVector(fakeVector("python accumulator")) },
      { chunk: chunk("c", "boot double"), vector: normalizeVector(fakeVector("boot double")) },
    ]);

    const hits = store.search(normalizeVector(fakeVector("registry")), 3);
    assert.equal(hits[0]?.chunk.id, "a");
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  it("returns at most k hits", () => {
    const store = BruteForceStore.empty(dir, "fake-embed");
    store.replace(
      ["a", "b", "c", "d"].map((id) => ({
        chunk: chunk(id, "registry"),
        vector: normalizeVector(fakeVector("registry")),
      })),
    );
    assert.equal(store.search(normalizeVector(fakeVector("registry")), 2).length, 2);
  });

  it("round-trips through disk", async () => {
    const store = BruteForceStore.empty(dir, "fake-embed");
    store.replace([
      { chunk: chunk("a", "registry helper"), vector: normalizeVector(fakeVector("registry helper")) },
    ]);
    await store.save();

    const reloaded = await BruteForceStore.load(dir, "fake-embed");
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.dim, VOCAB.length);
    assert.equal(reloaded.search(normalizeVector(fakeVector("registry helper")), 1)[0]?.chunk.id, "a");
  });

  it("reuses a vector only when the hash and model both match", async () => {
    const store = await BruteForceStore.load(dir, "fake-embed");
    const same = { ...chunk("a", "registry helper") };
    assert.ok(store.reusable(same, "fake-embed"), "unchanged text should be reusable");
    assert.equal(store.reusable(chunk("a", "different text"), "fake-embed"), undefined);
    assert.equal(store.reusable(same, "other-model"), undefined);
  });

  it("refuses a query whose dimensions do not match the index", async () => {
    const store = await BruteForceStore.load(dir, "fake-embed");
    assert.throws(
      () => store.search(new Float32Array(3), 1),
      /Re-run `synapse index` after changing --embed-model/,
    );
  });

  it("treats a corrupt index as empty rather than failing", async () => {
    const broken = path.join(fixture.root, ".broken-index");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "embeddings.json"), "{ not json", "utf8");
    const store = await BruteForceStore.load(broken, "fake-embed");
    assert.equal(store.size, 0);
  });

  it("treats a manifest that disagrees with its vector file as empty", async () => {
    const mismatched = path.join(fixture.root, ".mismatched");
    await mkdir(mismatched, { recursive: true });
    await writeFile(
      path.join(mismatched, "embeddings.json"),
      JSON.stringify({ version: 1, model: "fake-embed", dim: 8, entries: [chunk("a", "x")] }),
      "utf8",
    );
    await writeFile(path.join(mismatched, "embeddings.bin"), Buffer.alloc(4));
    const store = await BruteForceStore.load(mismatched, "fake-embed");
    assert.equal(store.size, 0);
  });
});

describe("balanced retrieval", () => {
  const dir = "/unused";

  /** File chunks deliberately score higher than function chunks on the query. */
  const build = () => {
    const store = BruteForceStore.empty(dir, "fake-embed");
    const entries: Array<{ chunk: StoredChunk; vector: Float32Array }> = [];

    // Five file chunks that all match "registry" strongly.
    for (let i = 0; i < 5; i++) {
      entries.push({
        chunk: {
          id: `file:f${i}.ts`,
          kind: "file",
          path: `f${i}.ts`,
          importance: 1 - i / 100,
          text: "registry registry registry",
          hash: `hf${i}`,
          model: "fake-embed",
        },
        vector: normalizeVector(fakeVector("registry registry registry")),
      });
    }

    // Five function chunks that match the same query less strongly.
    for (let i = 0; i < 5; i++) {
      entries.push({
        chunk: {
          id: `fn:f${i}.ts#fn${i}`,
          kind: "function",
          path: `f${i}.ts`,
          ref: `fn${i}`,
          importance: 0.5 - i / 100,
          text: "registry helper double",
          hash: `hn${i}`,
          model: "fake-embed",
        },
        vector: normalizeVector(fakeVector("registry helper double")),
      });
    }

    store.replace(entries);
    return store;
  };

  const query = () => normalizeVector(fakeVector("registry registry registry"));

  it("lets long file chunks monopolise the results when ranking globally", () => {
    const hits = build().search(query(), 4, { balanceKinds: false });
    assert.ok(
      hits.every((h) => h.chunk.kind === "file"),
      "this is the failure mode the balance exists to fix",
    );
  });

  it("reserves half the seats for each kind", () => {
    const hits = build().search(query(), 4, { balanceKinds: true });
    assert.equal(hits.filter((h) => h.chunk.kind === "file").length, 2);
    assert.equal(hits.filter((h) => h.chunk.kind === "function").length, 2);
  });

  it("still returns the best chunks within each kind", () => {
    const hits = build().search(query(), 4, { balanceKinds: true });
    const files = hits.filter((h) => h.chunk.kind === "file");
    // Scores tie, so importance breaks it: f0 and f1 are the most important files.
    assert.deepEqual(files.map((h) => h.chunk.path), ["f0.ts", "f1.ts"]);
  });

  it("orders the merged result by relevance, not by kind", () => {
    const hits = build().search(query(), 6, { balanceKinds: true });
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i - 1]!.score >= hits[i]!.score, "results must stay sorted by score");
    }
  });

  it("gives an odd seat to the best remaining chunk of either kind", () => {
    const hits = build().search(query(), 5, { balanceKinds: true });
    assert.equal(hits.length, 5);
    // floor(5/2) = 2 each, and the spare goes to the higher-scoring kind.
    assert.equal(hits.filter((h) => h.chunk.kind === "file").length, 3);
  });

  it("backfills from the other kind when one kind is scarce", () => {
    const store = BruteForceStore.empty(dir, "fake-embed");
    store.replace([
      {
        chunk: {
          id: "file:only.ts",
          kind: "file",
          path: "only.ts",
          importance: 1,
          text: "registry",
          hash: "h1",
          model: "fake-embed",
        },
        vector: normalizeVector(fakeVector("registry")),
      },
      {
        chunk: {
          id: "file:second.ts",
          kind: "file",
          path: "second.ts",
          importance: 0.9,
          text: "registry helper",
          hash: "h2",
          model: "fake-embed",
        },
        vector: normalizeVector(fakeVector("registry helper")),
      },
    ]);

    // No function chunks exist, so the file chunks must fill every seat.
    const hits = store.search(query(), 2, { balanceKinds: true });
    assert.equal(hits.length, 2);
  });

  it("falls back to the global best when there is only one seat", () => {
    const hits = build().search(query(), 1, { balanceKinds: true });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.chunk.kind, "file", "the single seat goes to the best match overall");
  });
});

describe("buildIndex", () => {
  let fixture: Fixture;
  let graph: RepoGraph;
  let cacheDir: string;
  let caseNumber = 0;

  before(async () => {
    fixture = await createFixture();
  });

  beforeEach(async () => {
    cacheDir = path.join(fixture.root, `.index-${++caseNumber}`);
    graph = await summarisedGraph(fixture.root);
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("embeds every chunk on a cold build", async () => {
    const embedder = new FakeEmbedder();
    const report = await buildIndex(graph, { root: fixture.root, cacheDir, backend: embedder });

    assert.equal(report.ran, true);
    assert.equal(report.reused, 0);
    assert.equal(report.embedded, report.total);
    assert.equal(report.dim, VOCAB.length);
    assert.ok(report.total > graph.nodes.length, "file chunks plus function chunks");
  });

  it("reuses every vector on an unchanged rebuild", async () => {
    const first = new FakeEmbedder();
    const cold = await buildIndex(graph, { root: fixture.root, cacheDir, backend: first });

    const second = new FakeEmbedder();
    const warm = await buildIndex(await summarisedGraph(fixture.root), {
      root: fixture.root,
      cacheDir,
      backend: second,
    });

    assert.equal(warm.total, cold.total);
    assert.equal(warm.reused, cold.total);
    assert.equal(warm.embedded, 0);
    assert.equal(second.calls, 0, "nothing changed, so nothing should be embedded");
  });

  it("re-embeds only the chunks whose text actually changed", async () => {
    const first = new FakeEmbedder();
    await buildIndex(graph, { root: fixture.root, cacheDir, backend: first });

    const changed = await summarisedGraph(fixture.root);
    const target = changed.nodes.find((n) => n.path === "orphan.ts")!;
    target.summary = "A completely different summary that changes this chunk's text.";

    const second = new FakeEmbedder();
    const report = await buildIndex(changed, { root: fixture.root, cacheDir, backend: second });

    assert.equal(report.embedded, 1, "only the edited file's chunk should be re-embedded");
    assert.equal(second.texts.length, 1);
    assert.match(second.texts[0]!, /completely different summary/);
  });

  it("invalidates the whole index when the embedding model changes", async () => {
    const first = new FakeEmbedder();
    const cold = await buildIndex(graph, {
      root: fixture.root,
      cacheDir,
      backend: first,
      embedModel: "model-a",
    });

    const second = new FakeEmbedder();
    const report = await buildIndex(graph, {
      root: fixture.root,
      cacheDir,
      backend: second,
      embedModel: "model-b",
    });

    assert.equal(report.reused, 0, "vectors from two models are not comparable");
    assert.equal(report.embedded, cold.total);
  });

  it("reports remediation instead of throwing when preflight fails", async () => {
    const embedder = new FakeEmbedder({
      preflight: { ok: false, message: "ollama pull nomic-embed-text" },
    });
    const report = await buildIndex(graph, { root: fixture.root, cacheDir, backend: embedder });

    assert.equal(report.ran, false);
    assert.match(report.message ?? "", /ollama pull nomic-embed-text/);
    assert.equal(embedder.calls, 0);
  });

  it("reports the failure instead of throwing when embedding errors", async () => {
    const embedder = new FakeEmbedder({ throws: "does not support embeddings" });
    const report = await buildIndex(graph, { root: fixture.root, cacheDir, backend: embedder });

    assert.equal(report.ran, false);
    assert.match(report.message ?? "", /does not support embeddings/);
  });

  it("rejects an index whose vectors are not all the same width", async () => {
    const embedder = new FakeEmbedder({ ragged: true });
    const report = await buildIndex(graph, { root: fixture.root, cacheDir, backend: embedder });

    assert.equal(report.ran, false);
    assert.match(report.message ?? "", /inconsistent vector sizes/);
  });
});

describe("buildAnswerPrompt", () => {
  const hits = [
    {
      chunk: {
        id: "file:hub.ts",
        kind: "file" as const,
        path: "hub.ts",
        importance: 1,
        text: "File: hub.ts\nSummary: the hub.",
        hash: "h",
        model: "fake-embed",
      },
      score: 0.93,
    },
    {
      chunk: {
        id: "fn:hub.ts#sharedHelper",
        kind: "function" as const,
        path: "hub.ts",
        ref: "sharedHelper",
        startLine: 1,
        importance: 1,
        text: "Function: sharedHelper",
        hash: "h2",
        model: "fake-embed",
      },
      score: 0.81,
    },
  ];

  const prompt = buildAnswerPrompt("What does the hub do?", hits);

  it("includes the question", () => {
    assert.match(prompt, /Question: What does the hub do\?/);
  });

  it("includes each retrieved chunk with its source label", () => {
    assert.match(prompt, /\[1\] hub\.ts/);
    assert.match(prompt, /\[2\] sharedHelper in hub\.ts/);
    assert.match(prompt, /Summary: the hub\./);
  });

  it("tells the model to admit when the context is insufficient", () => {
    assert.match(prompt, /does not contain enough to answer/);
  });
});

describe("ask", () => {
  let fixture: Fixture;
  let graph: RepoGraph;
  let cacheDir: string;
  let caseNumber = 0;

  before(async () => {
    fixture = await createFixture();
  });

  beforeEach(async () => {
    cacheDir = path.join(fixture.root, `.ask-${++caseNumber}`);
    graph = await summarisedGraph(fixture.root);
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("builds an index on demand, answers, and reports sources", async () => {
    const embedder = new FakeEmbedder();
    const chat = new FakeChat();

    const result = await ask("What does the registry do?", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: embedder,
      chatBackend: chat,
      topK: 3,
    });

    assert.equal(result.ok, true);
    assert.match(result.answer, /Registry/);
    assert.equal(result.sources.length, 3);
    assert.equal(chat.prompts.length, 1);
  });

  it("retrieves the chunks that actually share vocabulary with the question", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat(),
      topK: 4,
    });

    assert.ok(
      result.sources.some((s) => s.path === "hub.ts"),
      `hub.ts declares Registry and should be retrieved; got ${result.sources.map((s) => s.path).join(", ")}`,
    );
  });

  it("honours top-k", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat(),
      topK: 2,
    });
    assert.equal(result.sources.length, 2);
  });

  it("reuses an index a previous run built", async () => {
    const builder = new FakeEmbedder();
    await buildIndex(graph, { root: fixture.root, cacheDir, backend: builder });

    const embedder = new FakeEmbedder();
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: embedder,
      chatBackend: new FakeChat(),
    });

    assert.equal(result.ok, true);
    // One call, for the question itself — the corpus was already embedded.
    assert.equal(embedder.calls, 1);
    assert.deepEqual(embedder.texts, ["registry"]);
  });

  it("puts the retrieved context into the prompt it sends", async () => {
    const chat = new FakeChat();
    await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: chat,
      topK: 2,
    });

    const prompt = chat.prompts[0]!;
    assert.match(prompt, /=== RETRIEVED CONTEXT ===/);
    assert.match(prompt, /Question: registry/);
  });

  it("reports remediation when the embedding model is unavailable", async () => {
    const result = await ask("anything", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder({
        preflight: { ok: false, message: "ollama pull nomic-embed-text" },
      }),
      chatBackend: new FakeChat(),
    });

    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /ollama pull nomic-embed-text/);
    assert.equal(result.answer, "");
  });

  it("reports remediation when the chat model is unavailable", async () => {
    const result = await ask("anything", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat({ preflight: { ok: false, message: "ollama pull qwen2.5" } }),
    });

    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /ollama pull qwen2\.5/);
  });

  it("reports the failure when the chat model errors mid-answer", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat({ throws: "model exploded" }),
    });

    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /model exploded/);
  });

  it("explains what to run when there is no index and no graph to build one", async () => {
    const result = await ask("anything", {
      cacheDir: path.join(fixture.root, ".no-index-at-all"),
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat(),
    });

    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /synapse analyze/);
    assert.match(result.message ?? "", /synapse index/);
  });

  it("surfaces a dimension mismatch as a re-index instruction", async () => {
    await buildIndex(graph, { root: fixture.root, cacheDir, backend: new FakeEmbedder() });

    // An embedder that returns a different width, as a different model would.
    const wrongWidth: EmbeddingBackend = {
      async preflight() {
        return { ok: true };
      },
      async embed(texts) {
        return texts.map(() => [1, 0, 0]);
      },
    };

    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: wrongWidth,
      chatBackend: new FakeChat(),
    });

    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /synapse index/);
  });

  it("balances kinds by default, so function chunks are not crowded out", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat(),
      topK: 4,
    });

    assert.ok(
      result.sources.some((s) => s.kind === "function"),
      `expected a function chunk in ${JSON.stringify(result.sources)}`,
    );
  });

  it("ranks purely by similarity when globalRank is set", async () => {
    const balanced = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat(),
      topK: 4,
    });

    const global = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      embedBackend: new FakeEmbedder(),
      chatBackend: new FakeChat(),
      topK: 4,
      globalRank: true,
    });

    const kinds = (r: typeof balanced) => r.sources.map((s) => s.kind).join(",");
    assert.notEqual(kinds(balanced), kinds(global), "the two strategies should differ here");
  });

  it("loads the store from disk, not from memory", async () => {
    await buildIndex(graph, { root: fixture.root, cacheDir, backend: new FakeEmbedder() });
    const store = await loadIndex(cacheDir, "nomic-embed-text");
    assert.ok(store.size > 0, "a fresh load should see what the build wrote");
  });
});
