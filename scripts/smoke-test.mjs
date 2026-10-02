#!/usr/bin/env node
/**
 * Installs the packed synapse-map tarball into an empty directory and runs it the way a
 * user would, so packaging bugs surface before release rather than after.
 *
 *   npm run release:pack && node scripts/smoke-test.mjs
 *
 * No model is needed: the analysis skips summaries, and nothing calls Ollama. Checks:
 *   - the package installs, and `synapse-map --version` matches its manifest
 *   - `analyze` builds a graph of this repository from the installed copy
 *   - `serve` answers its pages, its API and a missing route with the right codes
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = path.join(ROOT, "release");
const PORT = Number(process.env.SMOKE_PORT ?? 4399);

const tarball = readdirSync(RELEASE).find((f) => /^synapse-map-.*\.tgz$/.test(f));
if (!tarball) {
  console.error("smoke: no tarball in release/. Run `npm run release:pack` first.");
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "synapse-smoke-"));
const bin = path.join(dir, "node_modules", ".bin", process.platform === "win32" ? "synapse-map.cmd" : "synapse-map");
const cache = path.join(dir, "out");
let server;

function step(name) {
  console.log(`smoke: ${name}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  step(`installing ${tarball}`);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", path.join(RELEASE, tarball)], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  step("--version");
  const manifest = JSON.parse(readFileSync(path.join(dir, "node_modules/synapse-map/package.json"), "utf8"));
  const version = execFileSync(bin, ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  check(version === manifest.version, `--version printed ${version}, expected ${manifest.version}`);

  step("analyze this repository");
  execFileSync(bin, ["analyze", ROOT, "--skip-summarize", "--out", cache], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const graph = JSON.parse(readFileSync(path.join(cache, "graph.json"), "utf8"));
  check(graph.nodes.length > 10, `expected a real graph, got ${graph.nodes.length} files`);
  check(graph.stats.parseFailures === 0, `${graph.stats.parseFailures} files failed to parse`);

  step(`serve on :${PORT}`);
  server = spawn(bin, ["serve", ROOT, "--out", cache, "--no-open", "--port", String(PORT)], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  const base = `http://127.0.0.1:${PORT}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${base}/api/graph`);
      break;
    } catch {
      check(attempt < 60, "serve did not start listening within 30s");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const expect = [
    ["/", 200, "text/html"],
    ["/graph", 200, "text/html"],
    ["/api/graph", 200, "application/json"],
    ["/robots.txt", 200, "text/plain"],
    ["/does-not-exist", 404, "text/html"],
    ["/api/nope", 404, "application/json"],
  ];
  for (const [route, status, type] of expect) {
    const response = await fetch(base + route);
    check(response.status === status, `${route} answered ${response.status}, expected ${status}`);
    check(
      (response.headers.get("content-type") ?? "").startsWith(type),
      `${route} answered ${response.headers.get("content-type")}, expected ${type}`,
    );
    check(response.headers.get("content-security-policy") !== null, `${route} has no CSP header`);
  }

  const served = await (await fetch(`${base}/api/graph`)).json();
  check(served.nodes.length === graph.nodes.length, "/api/graph did not return the analysed graph");

  console.log(`smoke: passed (${graph.nodes.length} files analysed and served by synapse-map ${version})`);
} catch (error) {
  console.error(`smoke: FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
}
