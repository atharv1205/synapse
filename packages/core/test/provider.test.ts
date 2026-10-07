import assert from "node:assert/strict";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { AnthropicClient, API_KEY_ENV, DEFAULT_ANTHROPIC_MODEL } from "../src/llm/anthropic.js";
import { OllamaClient, DEFAULT_MODEL, DEFAULT_EMBED_MODEL } from "../src/llm/ollama.js";
import {
  createChatProvider,
  createEmbeddingProvider,
  createProviders,
  defaultModelFor,
} from "../src/llm/provider.js";
import { EmbeddingsUnsupportedError, type JsonSchema, type LlmProvider, type Preflight } from "../src/llm/types.js";
import { resolveFunctions } from "../src/graph/lookup.js";
import { summarizeGraph } from "../src/summarize/index.js";
import { buildFilePrompt, SUMMARY_SCHEMA } from "../src/summarize/prompt.js";
import { ask } from "../src/rag/ask.js";
import { buildIndex, type EmbeddingBackend } from "../src/rag/index.js";
import type { RepoGraph } from "../src/types.js";
import { createFixture, type Fixture } from "./fixture.js";

/**
 * Fake Anthropic API that records every prompt and schema it gets.
 *
 * It implements all of LlmProvider (including an `embed` that throws), so the tests hold
 * it to the same contract as the real client.
 */
class FakeAnthropic implements LlmProvider {
  readonly name: "anthropic" | "ollama";
  readonly model: string;
  readonly endpoint = "https://api.anthropic.com";
  readonly supportsEmbeddings = false;

  readonly prompts: string[] = [];
  readonly schemas: JsonSchema[] = [];
  calls = 0;

  constructor(
    private readonly behaviour: {
      preflight?: Preflight;
      throws?: string;
      /** Lets one fake act as either provider, so we can compare their prompts. */
      as?: "anthropic" | "ollama";
      model?: string;
    } = {},
  ) {
    this.name = behaviour.as ?? "anthropic";
    this.model = behaviour.model ?? "fake-claude";
  }

  async preflight(): Promise<Preflight> {
    return this.behaviour.preflight ?? { ok: true };
  }

  async generateText(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.calls++;
    if (this.behaviour.throws) throw new Error(this.behaviour.throws);
    return "Answered by the Anthropic API.";
  }

  async generateJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
    this.prompts.push(prompt);
    this.schemas.push(schema);
    this.calls++;
    if (this.behaviour.throws) throw new Error(this.behaviour.throws);

    const asked = [...prompt.matchAll(/^- ([\w.]+) \(\d+ resolved call site/gm)].map((m) => m[1]!);
    return {
      summary: "Summarised by the Anthropic API.",
      functions: asked.map((name) => ({ name, summary: `${name} does a thing.` })),
    } as T;
  }

  async embed(): Promise<number[][]> {
    throw new EmbeddingsUnsupportedError("anthropic");
  }
}

/** Deterministic fake embeddings, same idea as in the RAG tests. */
const VOCAB = ["registry", "helper", "python", "accumulator", "orphan", "import", "boot", "double"];
const fakeVector = (text: string) =>
  VOCAB.map((term) => text.toLowerCase().split(term).length - 1);

class FakeEmbedder implements EmbeddingBackend {
  calls = 0;
  constructor(private readonly behaviour: { preflight?: Preflight } = {}) {}
  async preflight(): Promise<Preflight> {
    return this.behaviour.preflight ?? { ok: true };
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map(fakeVector);
  }
}

/** Run `body` with ANTHROPIC_API_KEY set or unset, and put it back afterwards. */
async function withApiKey(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const original = process.env[API_KEY_ENV];
  if (value === undefined) delete process.env[API_KEY_ENV];
  else process.env[API_KEY_ENV] = value;
  try {
    await body();
  } finally {
    if (original === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = original;
  }
}

describe("provider selection", () => {
  it("defaults to Ollama", () => {
    const chat = createChatProvider();
    assert.equal(chat.name, "ollama");
    assert.ok(chat instanceof OllamaClient);
  });

  it("returns an Anthropic client when asked for one", () => {
    const chat = createChatProvider({ provider: "anthropic" });
    assert.equal(chat.name, "anthropic");
    assert.ok(chat instanceof AnthropicClient);
  });

  it("gives each provider its own default model", () => {
    assert.equal(defaultModelFor("ollama"), DEFAULT_MODEL);
    assert.equal(defaultModelFor("anthropic"), DEFAULT_ANTHROPIC_MODEL);
    assert.equal(createChatProvider({ provider: "anthropic" }).model, DEFAULT_ANTHROPIC_MODEL);
  });

  it("honours an explicit model over the provider default", () => {
    assert.equal(createChatProvider({ provider: "anthropic", model: "claude-sonnet-5" }).model, "claude-sonnet-5");
  });

  it("always embeds with Ollama, whatever the chat provider is", () => {
    for (const provider of ["ollama", "anthropic"] as const) {
      const embed = createEmbeddingProvider({ provider });
      assert.equal(embed.name, "ollama", `${provider} should still embed via Ollama`);
      assert.equal(embed.supportsEmbeddings, true);
    }
  });

  it("reports only Ollama as capable of embeddings", () => {
    assert.equal(createChatProvider().supportsEmbeddings, true);
    assert.equal(createChatProvider({ provider: "anthropic" }).supportsEmbeddings, false);
  });
});

describe("the split-provider constraint", () => {
  it("is silent when both halves are Ollama", () => {
    assert.equal(createProviders({ provider: "ollama" }).embedNote, undefined);
  });

  it("is stated plainly when chat is Anthropic", () => {
    const note = createProviders({ provider: "anthropic" }).embedNote;
    assert.ok(note, "a split provider pair must explain itself");
    assert.match(note, /embeddings/i);
    assert.match(note, /Ollama/);
    assert.match(note, new RegExp(DEFAULT_EMBED_MODEL));
  });

  it("throws rather than silently substituting a model", async () => {
    await assert.rejects(
      () => createChatProvider({ provider: "anthropic" }).embed(["x"], "any-model"),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingsUnsupportedError);
        assert.match((error as Error).message, /no embeddings endpoint/);
        assert.match((error as Error).message, /ollama serve/);
        return true;
      },
    );
  });
});

describe("AnthropicClient credentials", () => {
  it("fails preflight with remediation when the key is unset", async () => {
    await withApiKey(undefined, async () => {
      const result = await new AnthropicClient().preflight();
      assert.equal(result.ok, false);
      const message = result.ok === false ? result.message : "";
      assert.match(message, new RegExp(API_KEY_ENV));
      assert.match(message, /export /);
      assert.match(message, /--provider ollama/);
    });
  });

  it("says the key is read only from the environment", async () => {
    await withApiKey(undefined, async () => {
      const result = await new AnthropicClient().preflight();
      const message = result.ok === false ? result.message : "";
      assert.match(message, /never from a flag or a file/i);
    });
  });

  it("treats a blank key as unset", async () => {
    await withApiKey("   ", async () => {
      assert.equal(AnthropicClient.hasApiKey(), false);
      const result = await new AnthropicClient().preflight();
      assert.equal(result.ok, false);
    });
  });

  it("constructing a client without a key is not itself an error", async () => {
    await withApiKey(undefined, async () => {
      assert.doesNotThrow(() => new AnthropicClient());
    });
  });
});

describe("prompts are shared across providers", () => {
  let fixture: Fixture;
  let graph: RepoGraph;
  let cacheDir: string;
  let caseNumber = 0;

  before(async () => {
    fixture = await createFixture();
  });

  beforeEach(async () => {
    cacheDir = path.join(fixture.root, `.provider-${++caseNumber}`);
    graph = await analyze(fixture.root, { skipSummarize: true });
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("sends byte-identical summarisation prompts to both providers", async () => {
    // The strongest version of the claim: same graph, same files, two providers, and the
    // prompts can't differ by a single character. Comparing the two runs to each other
    // saves us from rebuilding a prompt by hand and getting that wrong.
    const viaOllama = new FakeAnthropic({ as: "ollama", model: "fake-local" });
    await summarizeGraph(graph, {
      root: fixture.root,
      cacheDir: `${cacheDir}-ollama`,
      backend: viaOllama,
      topN: 3,
    });

    const viaAnthropic = new FakeAnthropic({ as: "anthropic" });
    await summarizeGraph(await analyze(fixture.root, { skipSummarize: true }), {
      root: fixture.root,
      cacheDir: `${cacheDir}-anthropic`,
      backend: viaAnthropic,
      topN: 3,
    });

    assert.equal(viaAnthropic.prompts.length, viaOllama.prompts.length);
    assert.ok(viaOllama.prompts.length > 0, "the run must actually have summarised something");

    // Sort before comparing. Summarising runs two workers off one queue, so the order
    // prompts get recorded in isn't fixed. We're checking the same prompts get produced,
    // not that they come in the same order.
    assert.deepEqual([...viaAnthropic.prompts].sort(), [...viaOllama.prompts].sort());
    assert.ok(viaOllama.prompts.every((p) => p.includes("You are documenting one file")));
  });

  it("builds that prompt with the shared builder", async () => {
    const backend = new FakeAnthropic();
    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend, topN: 1 });

    const node = graph.nodes[0]!;
    const source = await readSource(fixture.root, node.path);
    const declarations = resolveFunctions(graph, node);
    const header = buildFilePrompt(node, declarations, source, [])
      .split("\n\nSummarise")[0]!
      .split("\n\nSource:")[0]!;

    assert.ok(
      backend.prompts[0]!.startsWith(header),
      "the prompt must come from buildFilePrompt, not be assembled by the client",
    );
  });

  it("passes the shared schema through unchanged", async () => {
    const backend = new FakeAnthropic();
    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend, topN: 1 });
    assert.deepEqual(backend.schemas[0], SUMMARY_SCHEMA);
  });

  it("attaches Anthropic summaries to the graph like any other provider", async () => {
    const backend = new FakeAnthropic();
    const report = await summarizeGraph(graph, { root: fixture.root, cacheDir, backend, topN: 2 });

    assert.equal(report.ran, true);
    assert.equal(report.generated, 2);
    assert.equal(report.model, "fake-claude");
    assert.match(graph.nodes[0]!.summary ?? "", /Anthropic API/);
  });

  it("caches Anthropic summaries under their own model key", async () => {
    const first = new FakeAnthropic();
    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend: first, topN: 2 });

    const second = new FakeAnthropic();
    const fresh = await analyze(fixture.root, { skipSummarize: true });
    const report = await summarizeGraph(fresh, {
      root: fixture.root,
      cacheDir,
      backend: second,
      topN: 2,
    });

    assert.equal(second.calls, 0, "unchanged files should not be re-sent to the API");
    assert.equal(report.fromCache, 2);
  });

  it("sends the Anthropic client the very same answering prompt", async () => {
    const chat = new FakeAnthropic();
    const embedder = new FakeEmbedder();

    const result = await ask("what does the registry do?", {
      root: fixture.root,
      graph,
      cacheDir,
      chatBackend: chat,
      embedBackend: embedder,
      topK: 3,
    });

    assert.equal(result.ok, true);
    assert.match(result.answer, /Anthropic API/);
    const prompt = chat.prompts[0]!;
    assert.match(prompt, /=== RETRIEVED CONTEXT ===/);
    assert.match(prompt, /Question: what does the registry do\?/);
  });

  it("reports which provider answered and which embedded", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      provider: "anthropic",
      chatBackend: new FakeAnthropic(),
      embedBackend: new FakeEmbedder(),
      topK: 2,
    });

    assert.equal(result.providers?.chat, "anthropic");
    assert.equal(result.providers?.embed, "ollama");
  });

  it("explains the split when the Ollama half is the one that is unavailable", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      provider: "anthropic",
      chatBackend: new FakeAnthropic(),
      embedBackend: new FakeEmbedder({
        preflight: { ok: false, message: "Could not reach Ollama at http://localhost:11434" },
      }),
    });

    assert.equal(result.ok, false);
    const message = result.message ?? "";
    assert.match(message, /Could not reach Ollama/);
    // Otherwise the user picks Anthropic and gets an Ollama error with no explanation.
    assert.match(message, /embeddings/i);
  });

  it("does not add the split note when both halves are Ollama", async () => {
    const result = await ask("registry", {
      root: fixture.root,
      graph,
      cacheDir,
      provider: "ollama",
      chatBackend: new FakeAnthropic(),
      embedBackend: new FakeEmbedder({
        preflight: { ok: false, message: "Could not reach Ollama at http://localhost:11434" },
      }),
    });

    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message ?? "", /embeddings have no/);
  });

  it("reports an Anthropic failure with its own message", async () => {
    const backend = new FakeAnthropic({
      preflight: { ok: false, message: "ANTHROPIC_API_KEY is not set." },
    });
    const report = await summarizeGraph(graph, { root: fixture.root, cacheDir, backend });

    assert.equal(report.ran, false);
    assert.match(report.message ?? "", /ANTHROPIC_API_KEY/);
    assert.equal(backend.calls, 0);
  });

  it("indexes with the embedding provider even when chat is Anthropic", async () => {
    const embedder = new FakeEmbedder();
    const report = await buildIndex(graph, {
      root: fixture.root,
      cacheDir,
      provider: "anthropic",
      backend: embedder,
    });

    assert.equal(report.ran, true);
    assert.ok(report.embedded > 0);
    assert.equal(report.embedModel, DEFAULT_EMBED_MODEL);
  });
});

async function readSource(root: string, relPath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(root, relPath), "utf8");
}
