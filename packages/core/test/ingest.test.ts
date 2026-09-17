import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { walkSourceFiles } from "../src/ingest/walk.js";
import { isRepoUrl } from "../src/ingest/source.js";
import { createFixture, type Fixture } from "./fixture.js";

describe("isRepoUrl", () => {
  it("recognises the URL forms git can clone", () => {
    assert.equal(isRepoUrl("https://github.com/owner/repo"), true);
    assert.equal(isRepoUrl("git@github.com:owner/repo.git"), true);
    assert.equal(isRepoUrl("ssh://git@host/repo.git"), true);
  });

  it("treats paths as local", () => {
    assert.equal(isRepoUrl("."), false);
    assert.equal(isRepoUrl("./some/dir"), false);
    assert.equal(isRepoUrl("/abs/path"), false);
  });
});

describe("walkSourceFiles", () => {
  let fixture: Fixture;
  let paths: string[];
  let manifests: string[];

  before(async () => {
    fixture = await createFixture();
    const result = await walkSourceFiles(fixture.root);
    paths = result.files.map((f) => f.path);
    manifests = result.manifests;
  });

  after(async () => {
    await fixture.cleanup();
  });

  it("finds every first-party source file", () => {
    for (const expected of ["hub.ts", "util.ts", "app.ts", "lib/index.ts", "orphan.ts", "py/main.py", "py/helpers.py"]) {
      assert.ok(paths.includes(expected), `expected to find ${expected}, got ${paths.join(", ")}`);
    }
  });

  it("skips node_modules", () => {
    assert.ok(!paths.some((p) => p.includes("node_modules")));
  });

  it("honours .gitignore directory and glob patterns", () => {
    assert.ok(!paths.includes("generated/output.ts"), "generated/ should be ignored");
    assert.ok(!paths.includes("stale.gen.ts"), "*.gen.ts should be ignored");
  });

  it("honours .gitignore negation", () => {
    assert.ok(paths.includes("keep.gen.ts"), "!keep.gen.ts should re-include the file");
  });

  it("detects the language of each file", async () => {
    const { files } = await walkSourceFiles(fixture.root);
    const byPath = new Map(files.map((f) => [f.path, f.language]));
    assert.equal(byPath.get("hub.ts"), "typescript");
    assert.equal(byPath.get("py/main.py"), "python");
  });

  it("returns paths sorted for stable output", () => {
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
  });

  it("collects package.json manifests separately from source files", () => {
    assert.ok(!paths.some((p) => p.endsWith("package.json")));
    assert.ok(Array.isArray(manifests));
  });
});
