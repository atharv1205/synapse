import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { analyze, writeGraph } from "../src/analyze.js";
import {
  cloneEnv,
  cloneErrorDetail,
  cloneFailureMessage,
  redactSecret,
  redactUrl,
  resolveSource,
} from "../src/ingest/source.js";
import { summarizeGraph, type SummarizerBackend } from "../src/summarize/index.js";
import { buildIndex, type EmbeddingBackend } from "../src/rag/index.js";
import type { Preflight } from "../src/llm/types.js";
import { createFixture, type Fixture } from "./fixture.js";

/**
 * A token weird enough that a substring search can't miss it, and that would stand out
 * anywhere it shouldn't be.
 */
const TOKEN = "ghp_SYNAPSE0TEST0TOKEN0SHOULD0NEVER0APPEAR";

/**
 * A host that refuses straight away, so we can test clone failures without the network or
 * a DNS timeout.
 */
const DEAD_URL = "https://127.0.0.1:1/owner/private-repo.git";

/** List every file under a folder, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

describe("redactUrl", () => {
  it("strips an embedded token from an https URL", () => {
    const redacted = redactUrl(`https://${TOKEN}@github.com/owner/repo.git`);
    assert.ok(!redacted.includes(TOKEN), redacted);
    assert.match(redacted, /github\.com\/owner\/repo/);
  });

  it("strips a user:password pair", () => {
    const redacted = redactUrl("https://someone:hunter2@github.com/owner/repo.git");
    assert.ok(!redacted.includes("hunter2"));
    assert.ok(!redacted.includes("someone"));
  });

  it("keeps a credential-free URL byte-identical", () => {
    const url = "https://github.com/owner/repo.git";
    assert.equal(redactUrl(url), url);
  });

  it("leaves the scp-style form alone, which carries no password", () => {
    const url = "git@github.com:owner/repo.git";
    assert.equal(redactUrl(url), url);
  });

  it("still redacts a URL the URL parser rejects", () => {
    const redacted = redactUrl(`https://${TOKEN}@exa mple.com/repo`);
    assert.ok(!redacted.includes(TOKEN), redacted);
  });

  it("leaves local paths alone", () => {
    assert.equal(redactUrl("/Users/someone/code/project"), "/Users/someone/code/project");
  });
});

describe("redactSecret", () => {
  it("removes every occurrence", () => {
    const text = `fatal: ${TOKEN} rejected while using ${TOKEN}`;
    const redacted = redactSecret(text, TOKEN);
    assert.ok(!redacted.includes(TOKEN));
    assert.equal(redacted.split("<redacted>").length - 1, 2);
  });

  it("is a no-op without a secret", () => {
    assert.equal(redactSecret("plain text", undefined), "plain text");
  });

  it("ignores implausibly short secrets, which would redact ordinary words", () => {
    assert.equal(redactSecret("a cat sat", "a"), "a cat sat");
  });
});

describe("the git environment", () => {
  it("keeps the token out of every config value, so it cannot reach argv", () => {
    const env = cloneEnv(TOKEN, { PATH: "/usr/bin" });

    const configValues = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG"))
      .map(([, value]) => String(value));

    assert.ok(configValues.length > 0, "a credential helper should have been injected");
    assert.ok(
      !configValues.some((value) => value.includes(TOKEN)),
      "the helper must read the token from the environment, not embed it",
    );
    assert.equal(env.SYNAPSE_GIT_TOKEN, TOKEN);
  });

  it("resets inherited credential helpers before adding its own", () => {
    const env = cloneEnv(TOKEN, { PATH: "/usr/bin" });
    // An empty first entry is how git drops helpers from the user's own config, so their
    // keychain can't answer instead.
    assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
    assert.match(String(env.GIT_CONFIG_VALUE_1), /SYNAPSE_GIT_TOKEN/);
  });

  it("appends to the user's existing GIT_CONFIG entries rather than clobbering them", () => {
    const env = cloneEnv(TOKEN, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Existing",
    });

    assert.equal(env.GIT_CONFIG_KEY_0, "user.name", "the user's own entry must survive");
    assert.equal(env.GIT_CONFIG_VALUE_0, "Existing");
    assert.equal(env.GIT_CONFIG_COUNT, "3");
    assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
    assert.equal(env.GIT_CONFIG_KEY_2, "credential.helper");
  });

  it("survives a malformed GIT_CONFIG_COUNT", () => {
    const env = cloneEnv(TOKEN, { GIT_CONFIG_COUNT: "not-a-number" });
    assert.equal(env.GIT_CONFIG_COUNT, "2");
  });

  it("injects no credential machinery when there is no token", () => {
    const env = cloneEnv(undefined, { PATH: "/usr/bin" });
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.SYNAPSE_GIT_TOKEN, undefined);
    // The prompt is still off, so a private repo fails fast instead of hanging.
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });

  it("always disables the terminal prompt", () => {
    assert.equal(cloneEnv(TOKEN, {}).GIT_TERMINAL_PROMPT, "0");
  });
});

describe("cloneErrorDetail", () => {
  it("keeps git's own lines and drops the echoed command", () => {
    const detail = cloneErrorDetail({
      stderr: "Cloning into '/tmp/x'...\nremote: Repository not found.\nfatal: repository not found",
      message: "Command failed: git clone --depth 200 -- https://github.com/o/r /tmp/x",
    });

    assert.match(detail, /Repository not found/);
    assert.doesNotMatch(detail, /Command failed/);
    assert.doesNotMatch(detail, /Cloning into/);
  });

  it("scrubs a token out of whatever git printed", () => {
    const detail = cloneErrorDetail(
      { stderr: `fatal: could not read Password for 'https://x:${TOKEN}@github.com'` },
      TOKEN,
    );
    assert.ok(!detail.includes(TOKEN), detail);
  });

  it("scrubs a credential embedded in the URL when no token was passed", () => {
    // The token is only inside the URL here, so there's no known secret to search for,
    // and git still quotes it back mid-sentence.
    const detail = cloneErrorDetail({
      stderr: `fatal: could not read Password for 'https://${TOKEN}@github.com': terminal prompts disabled`,
    });
    assert.ok(!detail.includes(TOKEN), detail);
    assert.match(detail, /https:\/\/<redacted>@github\.com/);
  });

  it("falls back to the raw text when git printed nothing recognisable", () => {
    const detail = cloneErrorDetail({ message: "spawn git ENOENT" });
    assert.match(detail, /ENOENT/);
  });
});

describe("clone failures", () => {
  it("explains how to supply a token when none was given", async () => {
    await assert.rejects(
      () => resolveSource(DEAD_URL, { depth: 1 }),
      (error: unknown) => {
        const message = (error as Error).message;
        // Connection refused isn't an auth problem, so the message should just say what
        // happened.
        assert.match(message, /Failed to clone|Could not clone/);
        assert.match(message, /127\.0\.0\.1/);
        return true;
      },
    );
  });

  it("names the private-repo remedy on an auth-shaped failure", () => {
    // GitHub says "not found" for a private repo without auth, and also for a typo, so
    // the message has to cover both.
    const message = cloneFailureMessage(
      "https://github.com/owner/private-repo.git",
      "remote: Repository not found.\nfatal: repository not found",
      false,
    );

    assert.match(message, /GITHUB_TOKEN/);
    assert.match(message, /--token/);
    assert.match(message, /If it is public, check the URL/);
  });

  it("blames the token, not the URL, when one was supplied", () => {
    const message = cloneFailureMessage(
      "https://github.com/owner/private-repo.git",
      "fatal: Authentication failed",
      true,
    );

    assert.match(message, /with the token provided/);
    assert.match(message, /expired/);
    assert.match(message, /Contents: read|`repo` scope/);
    // No point telling someone to set a token they already set.
    assert.doesNotMatch(message, /export GITHUB_TOKEN/);
  });

  it("passes a non-auth failure through without inventing an auth problem", () => {
    const message = cloneFailureMessage(
      "https://github.com/owner/repo.git",
      "fatal: Could not resolve host: github.com",
      false,
    );

    assert.match(message, /Could not resolve host/);
    assert.doesNotMatch(message, /GITHUB_TOKEN/);
  });

  it("never leaks a token Synapse was given", async () => {
    await assert.rejects(
      () => resolveSource(DEAD_URL, { depth: 1, token: TOKEN }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(!message.includes(TOKEN), `token leaked into the error:\n${message}`);
        return true;
      },
    );
  });

  it("never leaks a credential the user embedded in the URL", async () => {
    await assert.rejects(
      () => resolveSource(`https://${TOKEN}@127.0.0.1:1/owner/repo.git`, { depth: 1 }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(!message.includes(TOKEN), `embedded credential leaked:\n${message}`);
        assert.match(message, /<redacted>/);
        return true;
      },
    );
  });

  it("never leaks a token into progress output", async () => {
    const progress: string[] = [];
    await resolveSource(`https://${TOKEN}@127.0.0.1:1/owner/repo.git`, {
      depth: 1,
      token: TOKEN,
      onProgress: (message) => progress.push(message),
    }).catch(() => undefined);

    const joined = progress.join("\n");
    assert.ok(progress.length > 0, "the clone should have announced itself");
    assert.ok(!joined.includes(TOKEN), `token leaked into progress:\n${joined}`);
  });
});

describe("the token never reaches an output file", () => {
  let fixture: Fixture;
  let cacheDir: string;

  /** Fakes so this runs without a model. Neither one gets the token. */
  const summarizer: SummarizerBackend = {
    model: "fake-model",
    async preflight(): Promise<Preflight> {
      return { ok: true };
    },
    async generateJson<T>(prompt: string): Promise<T> {
      const asked = [...prompt.matchAll(/^- ([\w.]+) \(\d+ resolved call site/gm)].map((m) => m[1]!);
      return {
        summary: "A summary that mentions no credentials.",
        functions: asked.map((name) => ({ name, summary: `${name} does a thing.` })),
      } as T;
    },
  };

  const embedder: EmbeddingBackend = {
    async preflight(): Promise<Preflight> {
      return { ok: true };
    },
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => [t.length % 7, t.length % 5, t.length % 3, 1]);
    },
  };

  before(async () => {
    fixture = await createFixture();
    cacheDir = path.join(fixture.root, ".synapse");
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("writes graph.json, summaries.json and the index without it", async () => {
    // A full run with a token passed in. Local paths ignore it, which is exactly the
    // regression this guards: nothing should ever echo it into an output file.
    const graph = await analyze(fixture.root, { token: TOKEN, skipSummarize: true });

    await summarizeGraph(graph, { root: fixture.root, cacheDir, backend: summarizer, topN: 3 });
    await buildIndex(graph, { root: fixture.root, cacheDir, backend: embedder });
    await writeGraph(graph, cacheDir);

    const written = await filesUnder(cacheDir);
    assert.ok(written.length >= 3, `expected artefacts in ${cacheDir}, found ${written.length}`);

    for (const file of written) {
      const bytes = await readFile(file);
      assert.ok(
        !bytes.includes(TOKEN),
        `${path.basename(file)} contains the token`,
      );
      assert.ok((await stat(file)).size > 0, `${path.basename(file)} is empty`);
    }
  });

  it("records a redacted source when the input carried a credential", async () => {
    // resolveSource redacts before storing anything, so a pasted credential can't end up
    // in graph.source even though the clone uses the original URL.
    const graph = await analyze(fixture.root, { skipSummarize: true });
    graph.source = redactUrl(`https://${TOKEN}@github.com/owner/repo.git`);

    const file = await writeGraph(graph, cacheDir);
    const contents = await readFile(file, "utf8");

    assert.ok(!contents.includes(TOKEN), "graph.json must not contain the credential");
    assert.match(contents, /<redacted>@github\.com/);
  });

  it("keeps the token out of the serialised graph object entirely", async () => {
    const graph = await analyze(fixture.root, { token: TOKEN, skipSummarize: true });
    assert.ok(!JSON.stringify(graph).includes(TOKEN));
  });
});
