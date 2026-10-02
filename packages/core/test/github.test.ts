import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { fetchRepositoryInfo, gitHubRepoOf, parseGitHubRepo } from "../src/ingest/github.js";
import { createFixture, type Fixture } from "./fixture.js";

const git = promisify(execFile);
const TOKEN = "ghp_githubTestToken0123456789";

/** A stand-in for fetch that records requests and answers from a script. */
function fakeFetch(answer: (url: string) => Response | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const result = answer(url);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const FLASK = {
  full_name: "pallets/flask",
  html_url: "https://github.com/pallets/flask",
  description: "The Python micro framework for building web applications.",
  stargazers_count: 69000,
  forks_count: 16000,
  language: "Python",
  topics: ["flask", "python", "wsgi"],
  license: { spdx_id: "BSD-3-Clause" },
  default_branch: "main",
  pushed_at: "2026-09-30T10:00:00Z",
  archived: false,
  private: false,
};

describe("parseGitHubRepo", () => {
  it("reads owner and name from every remote form", () => {
    for (const remote of [
      "https://github.com/pallets/flask",
      "https://github.com/pallets/flask.git",
      "https://github.com/pallets/flask/",
      `https://${TOKEN}@github.com/pallets/flask.git`,
      "git@github.com:pallets/flask.git",
      "ssh://git@github.com/pallets/flask.git",
    ]) {
      assert.deepEqual(parseGitHubRepo(remote), { owner: "pallets", name: "flask" }, remote);
    }
  });

  it("ignores repositories that are not on GitHub, and paths", () => {
    for (const remote of ["https://gitlab.com/o/r", "git@gitlab.com:o/r.git", "/home/me/code", "https://github.com/onlyowner"]) {
      assert.equal(parseGitHubRepo(remote), undefined, remote);
    }
  });
});

describe("fetchRepositoryInfo", () => {
  it("maps GitHub's answer onto the repository's details", async () => {
    const fake = fakeFetch(() => json(FLASK));
    const result = await fetchRepositoryInfo({ owner: "pallets", name: "flask" }, { fetch: fake.impl });
    assert.ok(result.ok);
    assert.equal(fake.calls[0]!.url, "https://api.github.com/repos/pallets/flask");
    assert.equal(result.info.fullName, "pallets/flask");
    assert.equal(result.info.stars, 69000);
    assert.equal(result.info.language, "Python");
    assert.equal(result.info.license, "BSD-3-Clause");
    assert.deepEqual(result.info.topics, ["flask", "python", "wsgi"]);
    assert.equal(result.info.archived, undefined, "false flags are left out");
  });

  it("sends a token only when there is one", async () => {
    const anonymous = fakeFetch(() => json(FLASK));
    await fetchRepositoryInfo({ owner: "o", name: "r" }, { fetch: anonymous.impl });
    assert.equal(anonymous.calls[0]!.headers.authorization, undefined);

    const authed = fakeFetch(() => json(FLASK));
    await fetchRepositoryInfo({ owner: "o", name: "r" }, { fetch: authed.impl, token: TOKEN });
    assert.equal(authed.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  });

  it("explains a private repository, a used-up rate limit and a network failure", async () => {
    const cases: Array<[() => Response | Error, RegExp, string?]> = [
      [() => json({ message: "Not Found" }, 404), /if it is private, its details need a token/],
      [() => json({ message: "Not Found" }, 404), /no repository o\/r that this token can see/, TOKEN],
      [() => json({}, 403, { "x-ratelimit-remaining": "0" }), /rate limit .* used up/],
      [() => new Error(`connect ECONNREFUSED with ${TOKEN}`), /Could not reach GitHub/, TOKEN],
    ];
    for (const [answer, expected, token] of cases) {
      const result = await fetchRepositoryInfo({ owner: "o", name: "r" }, { fetch: fakeFetch(answer).impl, token });
      assert.equal(result.ok, false);
      const reason = result.ok ? "" : result.reason;
      assert.match(reason, expected);
      assert.ok(!reason.includes(TOKEN), `the token leaked into: ${reason}`);
    }
  });
});

describe("GitHub details during analysis", () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await createFixture();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("finds a local folder's GitHub origin", async () => {
    assert.equal(await gitHubRepoOf(fixture.root), undefined, "the fixture starts with no remote");
    await git("git", ["remote", "add", "origin", "git@github.com:pallets/flask.git"], { cwd: fixture.root });
    assert.deepEqual(await gitHubRepoOf(fixture.root), { owner: "pallets", name: "flask" });
  });

  it("attaches the details to the graph", async () => {
    const fake = fakeFetch(() => json(FLASK));
    const graph = await analyze(fixture.root, { skipSummarize: true, githubFetch: fake.impl });
    assert.equal(fake.calls.length, 1);
    assert.equal(graph.repository?.fullName, "pallets/flask");
    assert.equal(graph.repository?.stars, 69000);
  });

  it("still builds the graph when GitHub cannot be reached", async () => {
    const progress: string[] = [];
    const fake = fakeFetch(() => new Error("fetch failed"));
    const graph = await analyze(fixture.root, {
      skipSummarize: true,
      githubFetch: fake.impl,
      onProgress: (line) => progress.push(line),
    });
    assert.equal(graph.repository, undefined);
    assert.ok(graph.nodes.length > 0);
    assert.ok(progress.some((line) => /Could not reach GitHub/.test(line)));
  });

  it("asks nothing of GitHub with skipGitHub", async () => {
    const fake = fakeFetch(() => json(FLASK));
    const graph = await analyze(fixture.root, { skipSummarize: true, skipGitHub: true, githubFetch: fake.impl });
    assert.equal(fake.calls.length, 0);
    assert.equal(graph.repository, undefined);
  });
});
