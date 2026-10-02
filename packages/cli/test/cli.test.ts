import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveOutDir, serveTarget } from "../src/target.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// dist/test/cli.test.js -> dist/src/index.js
const CLI = path.resolve(here, "../src/index.js");
const TOKEN = "ghp_cliTestToken0123456789";

describe("serve's target", () => {
  it("keeps a GitHub URL a URL instead of resolving it as a path", () => {
    // The bug: path.resolve turned this into <cwd>/https:/github.com/pallets/flask.
    const target = serveTarget("https://github.com/pallets/flask", undefined, "/work");
    assert.equal(target.root, "https://github.com/pallets/flask");
    assert.equal(target.cloneTarget, "https://github.com/pallets/flask");
    assert.equal(target.cacheDir, path.join("/work", ".synapse"));
  });

  it("redacts a credential in the URL everywhere except the clone", () => {
    const target = serveTarget(`https://${TOKEN}@github.com/org/private`, undefined, "/work");
    assert.ok(!target.root.includes(TOKEN), target.root);
    assert.ok(target.cloneTarget?.includes(TOKEN));
  });

  it("resolves a local path against the working directory", () => {
    const target = serveTarget("../project", undefined, "/work/here");
    assert.equal(target.root, path.resolve("/work/project"));
    assert.equal(target.cloneTarget, undefined);
    assert.equal(target.cacheDir, path.resolve("/work/project/.synapse"));
  });

  it("honours --out for both kinds of target", () => {
    assert.equal(resolveOutDir("https://github.com/o/r", "cache", "/work"), path.resolve("/work/cache"));
    assert.equal(resolveOutDir(".", "/abs/cache", "/work"), "/abs/cache");
  });
});

describe("the command", () => {
  it("prints the package version for --version and -v", async () => {
    const manifest = JSON.parse(await readFile(path.resolve(here, "../../package.json"), "utf8"));
    for (const flag of ["--version", "-v"]) {
      const { stdout } = await run(process.execPath, [CLI, flag]);
      assert.equal(stdout.trim(), manifest.version);
    }
  });

  it("documents URL targets and --token for serve in --help", async () => {
    const { stdout } = await run(process.execPath, [CLI, "--help"]);
    assert.match(stdout, /serve \[path-or-github-url\]/);
    assert.match(stdout, /serve:[\s\S]*--token/);
  });

  it("lists gemini as a provider in --help", async () => {
    const { stdout } = await run(process.execPath, [CLI, "--help"]);
    assert.match(stdout, /--provider <name>\s+ollama \| gemini \| anthropic/);
    assert.match(stdout, /GEMINI_API_KEY from the environment only/);
  });

  it("rejects an unknown provider with the allowed values", async () => {
    await assert.rejects(run(process.execPath, [CLI, "analyze", ".", "--provider", "bogus"]), (error: unknown) => {
      const failure = error as { code: number; stderr: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /Use "ollama", "gemini" or "anthropic"/);
      return true;
    });
  });

  it("exits non-zero with usage when given no command", async () => {
    await assert.rejects(run(process.execPath, [CLI]), (error: unknown) => {
      assert.equal((error as { code: number }).code, 1);
      return true;
    });
  });
});
