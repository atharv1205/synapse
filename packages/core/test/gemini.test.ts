import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ApiError } from "@google/genai";
import { analyze } from "../src/analyze.js";
import {
  DEFAULT_GEMINI_EMBED_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_KEY_ENV,
  GeminiClient,
  type GeminiTransport,
} from "../src/llm/gemini.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_MODEL } from "../src/llm/ollama.js";
import { createProviders, defaultEmbedModelFor, defaultModelFor } from "../src/llm/provider.js";
import { buildIndex, loadIndex } from "../src/rag/index.js";
import { indexFiles, INDEX_FILENAME } from "../src/rag/store.js";
import { summarizeGraph } from "../src/summarize/index.js";
import { SUMMARY_SCHEMA } from "../src/summarize/prompt.js";
import { createFixture, type Fixture } from "./fixture.js";

/**
 * Fake Gemini SDK, one level below GeminiClient, so these tests run the real client code
 * (request shapes, refusals, error messages, the one-vector-per-input check) without
 * calling the API.
 */
class FakeGemini implements GeminiTransport {
  readonly generated: Array<{ model: string; contents: string; config?: Record<string, unknown> }> = [];
  readonly embedded: Array<{ model: string; contents: string[]; config?: Record<string, unknown> }> = [];
  reply: { text?: string; promptFeedback?: { blockReason?: string }; candidates?: Array<{ finishReason?: string }> } = {
    text: JSON.stringify({ summary: "A file.", functions: [] }),
  };
  /**
   * Turn on to make embedContent squash a batch into one vector, like gemini-embedding-2
   * does.
   */
  aggregate = false;
  failure?: Error;

  readonly models = {
    generateContent: async (params: { model: string; contents: string; config?: Record<string, unknown> }) => {
      if (this.failure) throw this.failure;
      this.generated.push(params);
      return this.reply;
    },
    embedContent: async (params: { model: string; contents: string[]; config?: Record<string, unknown> }) => {
      if (this.failure) throw this.failure;
      this.embedded.push(params);
      const vector = (text: string) => [text.length % 7, 1, 2];
      return { embeddings: this.aggregate ? [{ values: vector("all") }] : params.contents.map((t) => ({ values: vector(t) })) };
    },
    get: async () => {
      if (this.failure) throw this.failure;
      return {};
    },
  };
}

function withoutKey<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env[GEMINI_KEY_ENV];
  delete process.env[GEMINI_KEY_ENV];
  return run().finally(() => {
    if (original !== undefined) process.env[GEMINI_KEY_ENV] = original;
  });
}

describe("choosing Gemini", () => {
  it("gives Gemini its own chat and embedding defaults", () => {
    assert.equal(defaultModelFor("gemini"), DEFAULT_GEMINI_MODEL);
    assert.equal(defaultEmbedModelFor("gemini"), DEFAULT_GEMINI_EMBED_MODEL);
    assert.equal(defaultModelFor("ollama"), DEFAULT_MODEL);
    assert.equal(defaultEmbedModelFor("ollama"), DEFAULT_EMBED_MODEL);
  });

  it("embeds with Gemini too, so Gemini mode needs no Ollama", () => {
    const pair = createProviders({ provider: "gemini" });
    assert.equal(pair.chat.name, "gemini");
    assert.equal(pair.embed.name, "gemini");
    assert.equal(pair.embedModel, DEFAULT_GEMINI_EMBED_MODEL);
    assert.equal(pair.embedNote, undefined);
  });

  it("leaves the local default untouched", () => {
    const pair = createProviders();
    assert.equal(pair.chat.name, "ollama");
    assert.equal(pair.embed.name, "ollama");
    assert.equal(pair.embedModel, DEFAULT_EMBED_MODEL);
  });
});

describe("the Gemini key", () => {
  it("fails preflight with remediation when GEMINI_API_KEY is unset", async () => {
    await withoutKey(async () => {
      const result = await new GeminiClient().preflight();
      assert.equal(result.ok, false);
      const message = result.ok ? "" : result.message;
      assert.match(message, /GEMINI_API_KEY is not set/);
      assert.match(message, /never from a flag, a file or the\s+web page/);
      assert.match(message, /--provider ollama/);
    });
  });

  it("constructing a client without a key is not itself an error", async () => {
    await withoutKey(async () => {
      assert.doesNotThrow(() => new GeminiClient());
      await assert.rejects(new GeminiClient().generateText("hi"), /GEMINI_API_KEY is not set/);
    });
  });
});

describe("GeminiClient", () => {
  it("passes the shared JSON schema through unchanged and parses the reply", async () => {
    const fake = new FakeGemini();
    fake.reply = { text: JSON.stringify({ summary: "Parses things.", functions: [{ name: "f", summary: "g" }] }) };
    const result = await new GeminiClient({ transport: fake }).generateJson<{ summary: string }>("prompt", SUMMARY_SCHEMA);

    assert.equal(result.summary, "Parses things.");
    assert.equal(fake.generated[0]!.model, DEFAULT_GEMINI_MODEL);
    assert.equal(fake.generated[0]!.contents, "prompt");
    assert.equal(fake.generated[0]!.config?.responseMimeType, "application/json");
    assert.deepEqual(fake.generated[0]!.config?.responseJsonSchema, SUMMARY_SCHEMA);
  });

  it("returns trimmed prose for text requests", async () => {
    const fake = new FakeGemini();
    fake.reply = { text: "  An answer.\n" };
    assert.equal(await new GeminiClient({ transport: fake }).generateText("q"), "An answer.");
  });

  it("reports a blocked prompt or a refusal instead of returning nothing", async () => {
    const fake = new FakeGemini();
    const client = new GeminiClient({ transport: fake });
    fake.reply = { promptFeedback: { blockReason: "SAFETY" } };
    await assert.rejects(client.generateText("q"), /declined the request \(SAFETY\)/);
    fake.reply = { text: "", candidates: [{ finishReason: "RECITATION" }] };
    await assert.rejects(client.generateText("q"), /stopped without answering \(RECITATION\)/);
  });

  it("embeds one vector per input at the reduced size", async () => {
    const fake = new FakeGemini();
    const vectors = await new GeminiClient({ transport: fake }).embed(["a", "bb", "ccc"], DEFAULT_GEMINI_EMBED_MODEL);
    assert.equal(vectors.length, 3);
    assert.deepEqual(fake.embedded[0]!.contents, ["a", "bb", "ccc"]);
    assert.equal(fake.embedded[0]!.config?.outputDimensionality, 768);
  });

  it("fails loudly when a model aggregates a batch into one vector", async () => {
    // gemini-embedding-2 does this. If we quietly accepted it, every chunk would get the
    // same vector and every question would return the same sources.
    const fake = new FakeGemini();
    fake.aggregate = true;
    await assert.rejects(
      new GeminiClient({ transport: fake }).embed(["a", "b"], "gemini-embedding-2"),
      /returned 1 embeddings for 2 inputs[\s\S]*gemini-embedding-001/,
    );
  });

  it("turns API errors into messages that say what to do", async () => {
    const cases: Array<[number, string, RegExp]> = [
      [400, "API key not valid. Please pass a valid API key.", /GEMINI_API_KEY was rejected/],
      [404, "models/nope is not found", /does not exist or is not available/],
      [429, "Resource exhausted", /rate-limited/],
    ];
    for (const [status, message, expected] of cases) {
      const fake = new FakeGemini();
      fake.failure = new ApiError({ status, message });
      const client = new GeminiClient({ transport: fake, model: "nope" });
      await assert.rejects(client.generateText("q"), expected, `status ${status}`);
      const preflight = await client.preflight();
      assert.equal(preflight.ok, false);
      assert.match(preflight.ok ? "" : preflight.message, expected);
    }
  });
});

describe("Gemini through the real pipeline", () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await createFixture();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("summarises with the same prompts the other providers receive", async () => {
    const fake = new FakeGemini();
    const graph = await analyze(fixture.root, { skipSummarize: true });
    const report = await summarizeGraph(graph, {
      root: fixture.root,
      cacheDir: path.join(fixture.root, ".gemini-summaries"),
      backend: new GeminiClient({ transport: fake }),
      topN: 3,
    });

    assert.equal(report.generated, 3);
    assert.equal(fake.generated.length, 3);
    assert.ok(fake.generated.every((g) => g.contents.includes("You are documenting one file")));
    assert.ok(graph.nodes.some((n) => n.summary === "A file."));
  });

  it("builds a question index from Gemini embeddings", async () => {
    const fake = new FakeGemini();
    const graph = await analyze(fixture.root, { skipSummarize: true });
    const report = await buildIndex(graph, {
      root: fixture.root,
      cacheDir: path.join(fixture.root, ".gemini-index"),
      provider: "gemini",
      backend: new GeminiClient({ transport: fake }),
    });

    assert.equal(report.ran, true);
    assert.equal(report.embedModel, DEFAULT_GEMINI_EMBED_MODEL);
    assert.equal(report.embedded, report.total);
    assert.ok(fake.embedded.length > 0);
    assert.ok(fake.embedded.every((call) => call.model === DEFAULT_GEMINI_EMBED_MODEL));
  });

  it("keeps each embedding model's index, so switching providers does not re-embed", async () => {
    const graph = await analyze(fixture.root, { skipSummarize: true });
    const cacheDir = path.join(fixture.root, ".two-models");
    const backend = new GeminiClient({ transport: new FakeGemini() });

    await buildIndex(graph, { root: fixture.root, cacheDir, backend, embedModel: "model-a" });
    await buildIndex(graph, { root: fixture.root, cacheDir, backend, embedModel: "model-b" });
    const again = await buildIndex(graph, { root: fixture.root, cacheDir, backend, embedModel: "model-a" });

    assert.equal(again.embedded, 0, "model-a's index survived model-b being built beside it");
    assert.ok((await loadIndex(cacheDir, "model-b")).size > 0);
  });
});

describe("index file names", () => {
  it("keeps the original names for the default local model, so old indexes load", () => {
    assert.equal(indexFiles(DEFAULT_EMBED_MODEL).manifest, INDEX_FILENAME);
  });

  it("gives every other model its own safe file name", () => {
    assert.equal(indexFiles("gemini-embedding-001").manifest, "embeddings-gemini-embedding-001.json");
    assert.equal(indexFiles("org/model:latest").vectors, "embeddings-org_model_latest.bin");
  });
});
