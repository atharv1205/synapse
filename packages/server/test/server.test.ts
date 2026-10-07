import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createServer, isLoopback, repoCacheDir } from "../src/index.js";

/**
 * These run the real server through Fastify's inject, which never opens a port. Nothing
 * here reaches a real Ollama: every server that answers /api/status is pointed at
 * 127.0.0.1:9, where nothing is listening.
 */

const LOCAL = { host: "localhost:4317" };

let dir: string;
let webDist: string;
let cacheDir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "synapse-server-"));
  webDist = path.join(dir, "web");
  cacheDir = path.join(dir, ".synapse");
  await mkdir(webDist, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(webDist, "robots.txt"), "User-agent: *\n");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function server(options: { host?: string; withGraph?: boolean } = {}): Promise<FastifyInstance> {
  if (options.withGraph) {
    const graph = { version: 2, source: "fixture", nodes: [], edges: [], functionNodes: [], functionEdges: [] };
    await writeFile(path.join(cacheDir, "graph.json"), JSON.stringify(graph));
  } else {
    await rm(path.join(cacheDir, "graph.json"), { force: true });
  }
  return createServer({ root: dir, cacheDir, webDist, host: options.host ?? "127.0.0.1" });
}

describe("isLoopback", () => {
  it("treats the default bind and every loopback form as loopback", () => {
    for (const host of [undefined, "127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) {
      assert.equal(isLoopback(host), true, String(host));
    }
  });

  it("treats network addresses as reachable", () => {
    for (const host of ["0.0.0.0", "192.168.1.20", "::"]) assert.equal(isLoopback(host), false, host);
  });
});

describe("the DNS-rebinding guard", () => {
  it("refuses a request addressed to another host when bound to loopback", async () => {
    const app = await server();
    const response = await app.inject({ url: "/api/graph", headers: { host: "evil.example:4317" } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "forbidden-host");
    await app.close();
  });

  it("answers requests addressed to every loopback name", async () => {
    const app = await server({ withGraph: true });
    for (const host of ["localhost:4317", "127.0.0.1:4317", "[::1]:4317"]) {
      const response = await app.inject({ url: "/api/graph", headers: { host } });
      assert.equal(response.statusCode, 200, host);
    }
    await app.close();
  });

  it("does not apply when deliberately bound to a network address", async () => {
    const app = await server({ host: "0.0.0.0", withGraph: true });
    const response = await app.inject({ url: "/api/graph", headers: { host: "192.168.1.20:4317" } });
    assert.equal(response.statusCode, 200);
    await app.close();
  });
});

describe("security headers", () => {
  it("are sent on pages, API responses and errors alike", async () => {
    const app = await server();
    for (const url of ["/", "/api/graph", "/nope"]) {
      const response = await app.inject({ url, headers: LOCAL });
      const csp = String(response.headers["content-security-policy"]);
      assert.match(csp, /default-src 'self'/, url);
      assert.match(csp, /frame-ancestors 'none'/, url);
      assert.equal(response.headers["x-frame-options"], "DENY", url);
      assert.equal(response.headers["x-content-type-options"], "nosniff", url);
      assert.equal(response.headers["referrer-policy"], "no-referrer", url);
    }
    await app.close();
  });
});

describe("pages and status codes", () => {
  it("serves the app shell with 200 for its own routes", async () => {
    const app = await server();
    for (const url of ["/", "/graph", "/graph/"]) {
      const response = await app.inject({ url, headers: LOCAL });
      assert.equal(response.statusCode, 200, url);
      assert.match(response.body, /<title>app<\/title>/, url);
    }
    await app.close();
  });

  it("serves the shell with a real 404 for unknown pages", async () => {
    const app = await server();
    const response = await app.inject({ url: "/does-not-exist", headers: LOCAL });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /<title>app<\/title>/);
    await app.close();
  });

  it("answers a missing file with a plain 404, never the HTML shell", async () => {
    const app = await server();
    for (const url of ["/sitemap.xml", "/missing.png", "/favicon.ico"]) {
      const response = await app.inject({ url, headers: LOCAL });
      assert.equal(response.statusCode, 404, url);
      assert.doesNotMatch(response.body, /<title>/, url);
    }
    await app.close();
  });

  it("serves real static files", async () => {
    const app = await server();
    const response = await app.inject({ url: "/robots.txt", headers: LOCAL });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /User-agent/);
    await app.close();
  });

  it("answers unknown API routes with JSON", async () => {
    const app = await server();
    const response = await app.inject({ url: "/api/nope", headers: LOCAL });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "not-found");
    await app.close();
  });
});

describe("the graph and ask routes", () => {
  it("explains how to build a graph when there is none", async () => {
    const app = await server();
    const response = await app.inject({ url: "/api/graph", headers: LOCAL });
    assert.equal(response.statusCode, 404);
    assert.match(response.json().message, /synapse analyze/);
    await app.close();
  });

  it("reports GitHub's details for the served repository in status", async () => {
    const repository = { host: "github.com", owner: "pallets", name: "flask", fullName: "pallets/flask", url: "https://github.com/pallets/flask", stars: 69000, fetchedAt: "now" };
    const graph = { version: 2, source: "fixture", stats: { fileCount: 0 }, nodes: [], edges: [], functionNodes: [], functionEdges: [], repository };
    await writeFile(path.join(cacheDir, "graph.json"), JSON.stringify(graph));
    const app = await createServer({ root: dir, cacheDir, ollamaUrl: "http://127.0.0.1:9" });
    const status = (await app.inject({ url: "/api/status", headers: LOCAL })).json();
    assert.equal(status.repository.fullName, "pallets/flask");
    assert.equal(status.repository.stars, 69000);
    await app.close();
  });

  it("returns the graph when there is one", async () => {
    const app = await server({ withGraph: true });
    const response = await app.inject({ url: "/api/graph", headers: LOCAL });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().source, "fixture");
    await app.close();
  });

  it("rejects a question that is missing or blank", async () => {
    const app = await server({ withGraph: true });
    for (const payload of [{}, { question: "   " }, { question: 42 }]) {
      const response = await app.inject({ method: "POST", url: "/api/ask", headers: LOCAL, payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    await app.close();
  });

  it("refuses to answer before there is a graph", async () => {
    const app = await server();
    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      headers: LOCAL,
      payload: { question: "what does this do?" },
    });
    assert.equal(response.statusCode, 409);
    await app.close();
  });
});

describe("analysing from the page", () => {
  /**
   * Fake version of core's analyze that records its calls and finishes when we say so.
   */
  function fakeAnalyzer() {
    const calls: Array<{ target: string; token?: string; provider?: string; cacheDir?: string }> = [];
    let finish!: () => void;
    let fail: ((error: Error) => void) | undefined;
    const analyzer = (target: string, options: { token?: string; provider?: string; cacheDir?: string }) => {
      calls.push({ target, token: options.token, provider: options.provider, cacheDir: options.cacheDir });
      return new Promise<never>((resolve, reject) => {
        finish = () =>
          resolve({
            version: 2,
            source: target,
            generatedAt: "now",
            stats: { fileCount: 1 },
            nodes: [],
            edges: [],
            functionNodes: [],
            functionEdges: [],
            parseFailures: [],
          } as never);
        fail = reject;
      });
    };
    return { calls, analyzer, finish: () => finish(), fail: (e: Error) => fail?.(e) };
  }

  async function page(fake = fakeAnalyzer()) {
    const reposDir = path.join(dir, `repos-${Math.random().toString(36).slice(2)}`);
    const app = await createServer({
      root: dir,
      cacheDir: path.join(dir, "empty-cache"),
      webDist,
      reposDir,
      ollamaUrl: "http://127.0.0.1:9",
      analyzer: fake.analyzer as never,
    });
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/analyze", headers: LOCAL, payload });
    return { app, fake, reposDir, post };
  }

  /**
   * Wait until the server says the analysis is done. A fixed pause wasn't enough on a
   * busy CI runner: saving the result took longer, and the next request saw "busy".
   */
  const settle = async (app: { inject: (options: object) => Promise<{ json(): { analysis?: { running?: boolean } } }> }) => {
    for (let i = 0; i < 250; i++) {
      const status = await app.inject({ url: "/api/status", headers: LOCAL });
      if (!status.json().analysis?.running) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the analysis did not finish within 5s");
  };

  it("analyses a pasted GitHub URL into its own folder and switches to it", async () => {
    const { app, fake, reposDir, post } = await page();
    const started = await post({ target: "https://github.com/pallets/flask", provider: "gemini" });
    assert.equal(started.statusCode, 202);
    assert.equal(started.json().root, "https://github.com/pallets/flask");

    assert.equal(fake.calls[0]!.target, "https://github.com/pallets/flask");
    assert.equal(fake.calls[0]!.provider, "gemini");
    assert.equal(fake.calls[0]!.cacheDir, path.join(reposDir, "github.com", "pallets", "flask"));

    const busy = await post({ target: "https://github.com/pallets/click" });
    assert.equal(busy.statusCode, 409, "a second analysis waits for the first");

    fake.finish();
    await settle(app);
    const graph = await app.inject({ url: "/api/graph", headers: LOCAL });
    assert.equal(graph.statusCode, 200);
    assert.equal(graph.json().source, "https://github.com/pallets/flask");
    await app.close();
  });

  it("uses a token for the clone and never returns it", async () => {
    const token = "ghp_serverTestToken0123456789";
    const { app, fake, post } = await page();
    const started = await post({ target: "https://github.com/org/private", token });
    assert.equal(fake.calls[0]!.token, token);
    assert.ok(!started.body.includes(token));
    const status = await app.inject({ url: "/api/status", headers: LOCAL });
    assert.ok(!status.body.includes(token), "status must not echo the token");
    fake.finish();
    await settle(app);
    await app.close();
  });

  it("strips a credential pasted into the URL from everything it returns", async () => {
    const token = "ghp_pastedIntoUrl0123456789";
    const { app, fake, post } = await page();
    const started = await post({ target: `https://${token}@github.com/org/private` });
    assert.ok(!started.body.includes(token));
    assert.ok(fake.calls[0]!.target.includes(token), "the clone still gets it");
    fake.finish();
    await settle(app);
    await app.close();
  });

  it("reopens a repository analysed before without analysing it again", async () => {
    const { app, fake, post } = await page();
    await post({ target: "https://github.com/pallets/flask" });
    fake.finish();
    await settle(app);

    const again = await post({ target: "https://github.com/pallets/flask" });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().status, "ready");
    assert.equal(fake.calls.length, 1);

    const forced = await post({ target: "https://github.com/pallets/flask", reanalyze: true });
    assert.equal(forced.statusCode, 202);
    assert.equal(fake.calls.length, 2);
    fake.finish();
    await settle(app);
    await app.close();
  });

  it("reports a failed analysis instead of spinning forever", async () => {
    const { app, fake, post } = await page();
    await post({ target: "https://github.com/org/missing" });
    fake.fail(new Error("Could not clone https://github.com/org/missing."));
    await settle(app);
    const status = (await app.inject({ url: "/api/status", headers: LOCAL })).json();
    assert.equal(status.analysis.running, false);
    assert.match(status.analysis.error, /Could not clone/);
    await app.close();
  });

  it("rejects what it cannot analyse, with a reason", async () => {
    const { app, post } = await page();
    const cases: Array<[object, RegExp]> = [
      [{}, /GitHub URL or a local folder/],
      [{ target: "   " }, /GitHub URL or a local folder/],
      [{ target: "git@github.com:org/repo.git" }, /https:\/\/ URL/],
      [{ target: "http://github.com/org/repo" }, /https:\/\/ URL/],
      [{ target: path.join(dir, "no-such-folder") }, /No folder at/],
      [{ target: "https://github.com/o/r", provider: "bogus" }, /must be one of/],
      [{ target: "https://github.com/o/r", token: 42 }, /must be a string/],
    ];
    for (const [payload, message] of cases) {
      const response = await post(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().message, message, JSON.stringify(payload));
    }
    await app.close();
  });

  it("analyses a local folder in place", async () => {
    const { app, fake, post } = await page();
    const started = await post({ target: dir });
    assert.equal(started.statusCode, 202);
    assert.equal(fake.calls[0]!.cacheDir, path.join(dir, ".synapse"));
    fake.finish();
    await settle(app);
    await app.close();
  });
});

describe("repoCacheDir", () => {
  it("lays repositories out by host, owner and name", () => {
    assert.equal(repoCacheDir("/repos", "https://github.com/pallets/flask.git"), path.join("/repos", "github.com", "pallets", "flask"));
  });

  it("cannot be steered outside the repos folder", () => {
    for (const url of ["https://github.com/../../etc/passwd", "https://github.com/%2e%2e/%2e%2e/x"]) {
      const resolved = repoCacheDir("/repos", url);
      assert.ok(resolved.startsWith(path.join("/repos") + path.sep), `${url} -> ${resolved}`);
    }
  });
});

describe("providers", () => {
  it("lists every provider with whether it can be used and why not", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const app = await createServer({ root: dir, cacheDir, ollamaUrl: "http://127.0.0.1:9" });
    const status = (await app.inject({ url: "/api/status", headers: LOCAL })).json();
    assert.deepEqual(Object.keys(status.providers).sort(), ["anthropic", "gemini", "ollama"]);
    assert.equal(status.providers.gemini.available, false);
    assert.match(status.providers.gemini.message, /GEMINI_API_KEY/);
    assert.equal(status.providers.ollama.available, false);
    assert.equal(status.defaultProvider, "ollama");

    process.env.GEMINI_API_KEY = "test-key";
    const keyed = (await app.inject({ url: "/api/status", headers: LOCAL })).json();
    assert.equal(keyed.providers.gemini.available, true);
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
    await app.close();
  });

  it("rejects an unknown provider on status and ask", async () => {
    const app = await server({ withGraph: true });
    const status = await app.inject({ url: "/api/status?provider=bogus", headers: LOCAL });
    assert.equal(status.statusCode, 400);
    const asked = await app.inject({
      method: "POST",
      url: "/api/ask",
      headers: LOCAL,
      payload: { question: "what?", provider: "bogus" },
    });
    assert.equal(asked.statusCode, 400);
    await app.close();
  });
});
