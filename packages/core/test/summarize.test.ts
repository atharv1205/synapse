import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { contentHash, SummaryCache } from "../src/summarize/cache.js";
import { parseJsonLoosely, OllamaClient } from "../src/summarize/ollama.js";
import {
  buildFilePrompt,
  signatureOf,
  truncateSource,
  MAX_SOURCE_CHARS,
} from "../src/summarize/prompt.js";
import { callCounts, rankFunctions, summarizeGraph, type SummarizerBackend } from "../src/summarize/index.js";
import type { FileNode, RepoGraph } from "../src/types.js";
import { createFixture, type Fixture } from "./fixture.js";

/**
 * A stand-in for Ollama that records every prompt it was given and replies with a
 * canned response. Nothing in this suite reaches a real model or the network.
 */
class FakeBackend implements SummarizerBackend {
  readonly model = "fake-model";
  readonly prompts: string[] = [];
  calls = 0;

  constructor(
    private readonly behaviour: {
      preflight?: { ok: true } | { ok: false; message: string };
      /** Thrown for every request, to exercise the per-file failure path. */
      throws?: string;
      /** Raw text returned instead of a well-formed object. */
      respond?: (prompt: string) => unknown;
    } = {},
  ) {}

  async preflight(): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.behaviour.preflight ?? { ok: true };
  }

  async generateJson<T>(prompt: string): Promise<T> {
    this.prompts.push(prompt);
    this.calls++;
    if (this.behaviour.throws) throw new Error(this.behaviour.throws);

    if (this.behaviour.respond) return this.behaviour.respond(prompt) as T;

    // Echo back the functions the prompt asked about, so name-matching is exercised.
    const asked = [...prompt.matchAll(/^- ([\w.]+) \(\d+ resolved call site/gm)].map((m) => m[1]!);
    return {
      summary: `Summary of a file. It has ${asked.length} notable functions. Third sentence.`,
      functions: asked.map((name) => ({ name, summary: `${name} does a thing.` })),
    } as T;
  }
}

describe("parseJsonLoosely", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(parseJsonLoosely('{"a":1}'), { a: 1 });
  });

  it("recovers JSON from a fenced block", () => {
    assert.deepEqual(parseJsonLoosely('```json\n{"a":1}\n```'), { a: 1 });
  });

  it("recovers JSON surrounded by prose", () => {
    assert.deepEqual(parseJsonLoosely('Sure! {"a":1} Hope that helps.'), { a: 1 });
  });

  it("throws a legible error when there is no JSON at all", () => {
    assert.throws(() => parseJsonLoosely("I cannot help with that"), /did not return JSON/);
  });
});

describe("OllamaClient preflight", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it("explains how to start Ollama when it is unreachable", async () => {
    await withFetch(
      (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
      async () => {
        const result = await new OllamaClient({ baseUrl: "http://localhost:1" }).preflight();
        assert.equal(result.ok, false);
        assert.match(result.ok === false ? result.message : "", /ollama serve/);
        assert.match(result.ok === false ? result.message : "", /--skip-summarize/);
      },
    );
  });

  it("explains how to pull the model when it is missing", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }), {
          status: 200,
        })) as unknown as typeof fetch,
      async () => {
        const result = await new OllamaClient({ model: "qwen2.5:14b-instruct" }).preflight();
        assert.equal(result.ok, false);
        const message = result.ok === false ? result.message : "";
        assert.match(message, /ollama pull qwen2\.5:14b-instruct/);
        assert.match(message, /llama3\.1:8b/);
      },
    );
  });

  it("accepts a bare model name against a :latest tag", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:latest" }] }), {
          status: 200,
        })) as unknown as typeof fetch,
      async () => {
        const result = await new OllamaClient({ model: "qwen2.5-coder" }).preflight();
        assert.equal(result.ok, true);
      },
    );
  });
});

describe("prompt construction", () => {
  const node: FileNode = {
    id: "src/hub.ts",
    path: "src/hub.ts",
    type: "file",
    language: "typescript",
    importance: 0.9,
    metrics: { loc: 40, churn: 7, outDegree: 2, inDegree: 5, centrality: 1, churnScore: 0.8 },
    functions: [
      {
        id: "src/hub.ts#sharedHelper",
        name: "sharedHelper",
        qualifiedName: "sharedHelper",
        kind: "function",
        startLine: 1,
        endLine: 3,
        exported: true,
        importance: 1,
      },
    ],
  };

  const source = "export function sharedHelper(value: number): number {\n  return value * 2;\n}\n";
  const ranked = rankFunctions(node, new Map([["src/hub.ts#sharedHelper", 4]]), source.split("\n"));
  const prompt = buildFilePrompt(node, source, ranked);

  it("includes the file path and language", () => {
    assert.match(prompt, /File: src\/hub\.ts/);
    assert.match(prompt, /Language: typescript/);
  });

  it("includes the importance metrics that made the file significant", () => {
    assert.match(prompt, /Imported by 5 other file\(s\)/);
    assert.match(prompt, /Imports 2 other file\(s\)/);
    assert.match(prompt, /Touched by 7 commit\(s\)/);
  });

  it("includes the function signatures", () => {
    assert.match(prompt, /sharedHelper/);
    assert.match(prompt, /export function sharedHelper\(value: number\): number/);
  });

  it("includes the source", () => {
    assert.match(prompt, /return value \* 2;/);
  });

  it("names the call count that selected each function", () => {
    assert.match(prompt, /sharedHelper \(4 resolved call site\(s\)\)/);
  });

  it("caps the source it sends and says that it did", () => {
    const huge = "x".repeat(MAX_SOURCE_CHARS * 3);
    const { text, truncated } = truncateSource(huge);
    assert.equal(truncated, true);
    assert.equal(text.length, MAX_SOURCE_CHARS);

    const big = buildFilePrompt(node, huge, ranked);
    assert.ok(big.length < huge.length, "prompt must be smaller than the file it describes");
    assert.match(big, /Source \(first 6000 of 18000 characters\)/);
  });

  it("derives a signature from the declaration's own line", () => {
    const symbol = node.functions[0]!;
    assert.equal(signatureOf(symbol, source.split("\n")), "export function sharedHelper(value: number): number");
  });
});

describe("function ranking", () => {
  it("counts incoming resolved calls per function", () => {
    const graph = {
      functionEdges: [
        { from: "a#x", to: "b#y", type: "call" as const, weight: 2 },
        { from: "c#z", to: "b#y", type: "call" as const, weight: 1 },
        { from: "a#x", to: "c#z", type: "call" as const, weight: 1 },
      ],
    } as RepoGraph;

    const counts = callCounts(graph);
    assert.equal(counts.get("b#y"), 3);
    assert.equal(counts.get("c#z"), 1);
  });

  it("returns at most the top 3 functions, most-called first", () => {
    const node: FileNode = {
      id: "f.ts",
      path: "f.ts",
      type: "file",
      language: "typescript",
      importance: 0.5,
      metrics: { loc: 10, churn: 0, outDegree: 0, inDegree: 0, centrality: 0, churnScore: 0 },
      functions: ["a", "b", "c", "d"].map((name, i) => ({
        id: `f.ts#${name}`,
        name,
        qualifiedName: name,
        kind: "function" as const,
        startLine: i + 1,
        endLine: i + 1,
        exported: true,
        importance: 0,
      })),
    };

    const counts = new Map([
      ["f.ts#a", 1],
      ["f.ts#b", 9],
      ["f.ts#c", 5],
      ["f.ts#d", 0],
    ]);

    const ranked = rankFunctions(node, counts, ["", "", "", ""]);
    assert.equal(ranked.length, 3);
    assert.deepEqual(ranked.map((r) => r.symbol.name), ["b", "c", "a"]);
  });
});

describe("summary cache", () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await createFixture();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("keys on file contents, so a changed file misses", () => {
    const a = contentHash("src/x.ts", "contents");
    const b = contentHash("src/x.ts", "contents changed");
    assert.notEqual(a, b);
    assert.equal(a, contentHash("src/x.ts", "contents"));
  });

  it("distinguishes identical contents at different paths", () => {
    assert.notEqual(contentHash("a.ts", "same"), contentHash("b.ts", "same"));
  });

  it("round-trips through disk", async () => {
    const dir = path.join(fixture.root, ".synapse");
    const cache = await SummaryCache.load(dir);
    const hash = contentHash("a.ts", "x");
    cache.set(hash, {
      path: "a.ts",
      model: "fake-model",
      promptVersion: 1,
      generatedAt: new Date().toISOString(),
      summary: "does a thing",
      functions: { foo: "foo does a thing" },
    });
    await cache.save(new Set([hash]));

    const reloaded = await SummaryCache.load(dir);
    assert.equal(reloaded.get(hash, "fake-model", 1)?.summary, "does a thing");
  });

  it("misses when the model or prompt version differs", async () => {
    const dir = path.join(fixture.root, ".synapse");
    const cache = await SummaryCache.load(dir);
    const hash = contentHash("a.ts", "x");
    assert.equal(cache.get(hash, "other-model", 1), undefined);
    assert.equal(cache.get(hash, "fake-model", 99), undefined);
  });

  it("treats a corrupt cache file as empty rather than failing", async () => {
    const dir = path.join(fixture.root, ".broken");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "summaries.json"), "{ not json", "utf8");
    const cache = await SummaryCache.load(dir);
    assert.equal(cache.size, 0);
  });
});

describe("summarizeGraph — against a fake model", () => {
  let fixture: Fixture;
  let graph: RepoGraph;
  let cacheDir: string;
  let caseNumber = 0;

  const freshGraph = async (): Promise<RepoGraph> =>
    analyze(fixture.root, { skipSummarize: true });

  before(async () => {
    fixture = await createFixture();
  });

  // Each case gets its own cache directory. Sharing one would let an earlier test's
  // summaries satisfy a later test's cache lookups and silently hide real regressions.
  beforeEach(async () => {
    cacheDir = path.join(fixture.root, `.cache-${++caseNumber}`);
    graph = await freshGraph();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("attaches file summaries onto the graph nodes", async () => {
    const backend = new FakeBackend();
    const report = await summarizeGraph(graph, { root: fixture.root, cacheDir, backend });

    assert.equal(report.ran, true);
    assert.ok(report.generated > 0);

    const hub = graph.nodes.find((n) => n.path === "hub.ts");
    assert.ok(hub?.summary, "hub.ts should carry a summary");
    assert.match(hub.summary, /Summary of a file/);
  });

  it("attaches function summaries to both the file node and the function graph", async () => {
    const backend = new FakeBackend();
    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend });

    const hub = graph.nodes.find((n) => n.path === "hub.ts");
    const symbol = hub?.functions.find((f) => f.qualifiedName === "sharedHelper");
    assert.ok(symbol?.summary, "the symbol on the file node should carry a summary");

    const twin = graph.functionNodes.find((f) => f.id === "hub.ts#sharedHelper");
    assert.equal(twin?.summary, symbol.summary, "the function-graph twin should match");
  });

  it("only summarises the top N files by importance", async () => {
    const backend = new FakeBackend();
    const report = await summarizeGraph(graph, { root: fixture.root, cacheDir, backend, topN: 2 });

    assert.equal(report.selected, 2);
    assert.equal(backend.calls, 2);

    const summarised = graph.nodes.filter((n) => n.summary);
    assert.equal(summarised.length, 2);
    // The graph is sorted by importance, so the two summarised files are the top two.
    assert.deepEqual(summarised.map((n) => n.path), graph.nodes.slice(0, 2).map((n) => n.path));
  });

  it("re-uses cached summaries on a second run and calls the model zero times", async () => {
    const first = new FakeBackend();
    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend: first, topN: 3 });
    assert.equal(first.calls, 3);

    const second = new FakeBackend();
    const fresh = await freshGraph();
    const report = await summarizeGraph(fresh, {
      root: fixture.root,
      cacheDir,
      backend: second,
      topN: 3,
    });

    assert.equal(second.calls, 0, "nothing changed, so the model should not be called");
    assert.equal(report.fromCache, 3);
    assert.equal(report.generated, 0);
    assert.ok(fresh.nodes[0]?.summary, "cached summaries must still be attached");
  });

  it("re-summarises only the file whose contents changed", async () => {
    const first = new FakeBackend();
    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend: first, topN: 3 });

    const target = graph.nodes[0]!.path;
    const abs = path.join(fixture.root, target);
    await writeFile(abs, `${await readFile(abs, "utf8")}\n// changed\n`, "utf8");

    const second = new FakeBackend();
    const fresh = await freshGraph();
    const report = await summarizeGraph(fresh, {
      root: fixture.root,
      cacheDir,
      backend: second,
      topN: 3,
    });

    assert.equal(second.calls, 1, "only the changed file should be re-summarised");
    assert.equal(report.fromCache, 2);
    assert.equal(report.generated, 1);
  });

  it("reports remediation and attaches nothing when preflight fails", async () => {
    const backend = new FakeBackend({
      preflight: { ok: false, message: "Ollama is not running. Start it with: ollama serve" },
    });
    const report = await summarizeGraph(graph, { root: fixture.root, cacheDir, backend });

    assert.equal(report.ran, false);
    assert.match(report.message ?? "", /ollama serve/);
    assert.equal(backend.calls, 0);
    assert.ok(!graph.nodes.some((n) => n.summary), "no summaries should be attached");
  });

  it("survives a model that fails on every file", async () => {
    const backend = new FakeBackend({ throws: "model exploded" });
    const report = await summarizeGraph(graph, { root: fixture.root, cacheDir, backend, topN: 2 });

    assert.equal(report.ran, true);
    assert.equal(report.failed, 2);
    assert.equal(report.generated, 0);
    assert.match(report.message ?? "", /could not be summarised/);
  });

  it("drops function names the file does not actually declare", async () => {
    const backend = new FakeBackend({
      respond: () => ({
        summary: "A file.",
        functions: [
          { name: "sharedHelper", summary: "real one" },
          { name: "totallyMadeUp", summary: "hallucinated" },
        ],
      }),
    });

    const fresh = await freshGraph();
    await summarizeGraph(fresh, {
      root: fixture.root,
      cacheDir,
      backend,
    });

    const hub = fresh.nodes.find((n) => n.path === "hub.ts");
    assert.equal(hub?.functions.find((f) => f.name === "sharedHelper")?.summary, "real one");
    assert.ok(
      !fresh.nodes.some((n) => n.functions.some((f) => f.summary === "hallucinated")),
      "a name the file does not declare must not be attached",
    );
  });
});

describe("analyze — summarisation wiring", () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await createFixture();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("skips summarisation entirely when asked", async () => {
    const graph = await analyze(fixture.root, {
      skipSummarize: true,
      cacheDir: path.join(fixture.root, ".synapse"),
    });
    assert.equal(graph.summarization, undefined);
    assert.ok(!graph.nodes.some((n) => n.summary));
  });

  it("skips summarisation when no cache directory is given", async () => {
    const graph = await analyze(fixture.root, {});
    assert.equal(graph.summarization, undefined);
  });

  it("runs summarisation through analyze() and reports it on the graph", async () => {
    const backend = new FakeBackend();
    const graph = await analyze(fixture.root, {
      cacheDir: path.join(fixture.root, ".synapse-wiring"),
      summarizeBackend: backend,
      summarizeTop: 2,
    });

    assert.equal(graph.summarization?.ran, true);
    assert.equal(graph.summarization?.selected, 2);
    assert.equal(graph.summarization?.model, "fake-model");
    assert.ok(graph.nodes[0]?.summary);
  });
});
