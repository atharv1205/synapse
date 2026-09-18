import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { functionIndex, resolveFunctions } from "../src/graph/lookup.js";
import { normalize, normalizeChurn } from "../src/graph/score.js";
import type { RepoGraph } from "../src/types.js";
import { BIG_FILE_MIN_CHARS, createFixture, type Fixture } from "./fixture.js";

describe("score normalisation", () => {
  it("maps a range onto 0..1", () => {
    const out = normalize(new Map([["a", 0], ["b", 5], ["c", 10]]));
    assert.equal(out.get("a"), 0);
    assert.equal(out.get("b"), 0.5);
    assert.equal(out.get("c"), 1);
  });

  it("maps a flat input to the midpoint rather than dividing by zero", () => {
    const out = normalize(new Map([["a", 3], ["b", 3]]));
    assert.equal(out.get("a"), 0.5);
    assert.equal(out.get("b"), 0.5);
  });

  it("compresses heavy-tailed churn so one outlier cannot flatten the rest", () => {
    const out = normalizeChurn(new Map([["a", 0], ["b", 10], ["c", 400]]));
    // Under plain min-max, b would land at 0.025; log scaling keeps it legible.
    assert.ok(out.get("b")! > 0.35, `expected b to stay visible, got ${out.get("b")}`);
    assert.equal(out.get("a"), 0);
    assert.equal(out.get("c"), 1);
  });
});

describe("analyze — fixture repo", () => {
  let fixture: Fixture;
  let graph: RepoGraph;

  before(async () => {
    fixture = await createFixture();
    graph = await analyze(fixture.root);
  });

  after(async () => {
    await fixture.cleanup();
  });

  const nodeFor = (path: string) => {
    const node = graph.nodes.find((n) => n.path === path);
    assert.ok(node, `no node for ${path}`);
    return node;
  };

  const hasEdge = (from: string, to: string) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.type === "import");

  it("includes every source file as a node", () => {
    const paths = graph.nodes.map((n) => n.path).sort();
    for (const expected of ["app.ts", "hub.ts", "lib/index.ts", "orphan.ts", "py/helpers.py", "py/main.py", "util.ts"]) {
      assert.ok(paths.includes(expected), `missing ${expected} in ${paths.join(", ")}`);
    }
  });

  it("resolves NodeNext-style ./foo.js specifiers back to foo.ts", () => {
    assert.ok(hasEdge("util.ts", "hub.ts"), "util.ts should import hub.ts");
    assert.ok(hasEdge("app.ts", "util.ts"), "app.ts should import util.ts");
  });

  it("resolves directory imports to index files", () => {
    assert.ok(hasEdge("app.ts", "lib/index.ts"), "app.ts should import lib/index.ts");
  });

  it("resolves relative Python imports", () => {
    assert.ok(hasEdge("py/main.py", "py/helpers.py"), "py/main.py should import py/helpers.py");
  });

  it("counts third-party imports as external rather than inventing nodes", () => {
    assert.ok(graph.stats.externalImports > 0, "express and os should count as external");
    assert.ok(!graph.nodes.some((n) => n.path.includes("express")));
  });

  it("gives every node an importance in 0..1", () => {
    for (const node of graph.nodes) {
      assert.ok(node.importance >= 0 && node.importance <= 1, `${node.path} scored ${node.importance}`);
    }
  });

  it("ranks the most-imported file above the file nothing imports", () => {
    assert.ok(
      nodeFor("hub.ts").importance > nodeFor("orphan.ts").importance,
      "hub.ts should outrank orphan.ts",
    );
  });

  it("makes the hub the single most central file", () => {
    const top = [...graph.nodes].sort((a, b) => b.metrics.centrality - a.metrics.centrality)[0];
    assert.equal(top?.path, "hub.ts");
  });

  it("records in- and out-degree consistently with the edge list", () => {
    const hub = nodeFor("hub.ts");
    assert.equal(hub.metrics.inDegree, 4, "hub is imported by app, util, lib/index and big");
    assert.equal(hub.metrics.outDegree, 0, "hub imports nothing internal");
    assert.equal(nodeFor("orphan.ts").metrics.inDegree, 0);
  });

  it("measures git churn from real history", () => {
    assert.equal(graph.stats.churnAvailable, true);
    assert.equal(nodeFor("hub.ts").metrics.churn, 3, "hub.ts was committed 3 times");
    assert.equal(nodeFor("app.ts").metrics.churn, 2, "app.ts was committed 2 times");
    assert.equal(nodeFor("orphan.ts").metrics.churn, 1, "orphan.ts was only in the initial commit");
  });

  it("lets churn break ties between files of equal centrality", () => {
    // app.ts and orphan.ts are both imported by nothing, so centrality is all they share;
    // app.ts has more commits and must therefore rank higher.
    assert.equal(nodeFor("app.ts").metrics.inDegree, nodeFor("orphan.ts").metrics.inDegree);
    assert.ok(nodeFor("app.ts").metrics.churnScore > nodeFor("orphan.ts").metrics.churnScore);
  });

  it("attaches the functions it found to each file node", () => {
    const hubFunctions = resolveFunctions(graph, nodeFor("hub.ts"))
      .map((f) => f.qualifiedName)
      .sort();
    assert.deepEqual(hubFunctions, ["Registry", "Registry.add", "Registry.total", "sharedHelper"]);
  });

  it("references declarations by id rather than duplicating them", () => {
    const hub = nodeFor("hub.ts");
    assert.ok(
      hub.functions.every((id) => typeof id === "string"),
      "file nodes should carry ids, not copies",
    );
    // Every id must resolve, or the graph is internally inconsistent.
    const index = functionIndex(graph);
    for (const node of graph.nodes) {
      for (const id of node.functions) {
        assert.ok(index.has(id), `${node.path} references a missing declaration ${id}`);
      }
    }
    // And every declaration must be claimed by exactly one file.
    const claimed = graph.nodes.flatMap((n) => n.functions);
    assert.equal(new Set(claimed).size, graph.functionNodes.length);
  });

  it("builds a function-level graph with resolved cross-file calls", () => {
    assert.ok(graph.functionNodes.length > 0);
    const call = graph.functionEdges.find(
      (e) => e.from === "util.ts#double" && e.to === "hub.ts#sharedHelper",
    );
    assert.ok(call, "double() calls the imported sharedHelper()");
  });

  it("ranks the most-called function highest", () => {
    const top = [...graph.functionNodes].sort((a, b) => b.importance - a.importance)[0];
    assert.equal(top?.id, "hub.ts#sharedHelper");
  });

  // --- regression: tree-sitter's 32KB string limit -------------------------
  //
  // Parser.parse() threw "Invalid argument" on any string of 32,768 characters or more,
  // and analyze() swallowed it, so every file above 32KB silently vanished from the
  // graph — 515 of 18,851 files on home-assistant/core, weighted toward the largest and
  // most depended-on files. These assertions fail loudly if that ever returns.

  it("parses a file larger than the old 32KB parser limit", async () => {
    const source = await readFile(path.join(fixture.root, "big.ts"), "utf8");
    assert.ok(
      source.length > BIG_FILE_MIN_CHARS,
      `the fixture must exceed the old limit; it is ${source.length} chars`,
    );
    assert.ok(graph.nodes.some((n) => n.path === "big.ts"), "big.ts is missing from the graph");
  });

  it("reports no parse failures at all", () => {
    assert.deepEqual(graph.parseFailures, [], "nothing should be dropping out of the graph");
    assert.equal(graph.stats.parseFailures, 0);
  });

  it("extracts declarations from the whole of an oversized file, not just its head", () => {
    const names = resolveFunctions(graph, nodeFor("big.ts")).map((f) => f.name);
    assert.ok(names.length > 10, `expected many declarations, got ${names.length}`);
    assert.ok(names.includes("bulky0"), "the first declaration should be present");
    // Declared on the final line: if the parse were truncated, this would be absent.
    assert.ok(names.includes("lastDeclaration"), "the last declaration should be present");
  });

  it("resolves imports out of an oversized file", () => {
    assert.ok(
      hasEdge("big.ts", "hub.ts"),
      "big.ts imports hub.ts; a dropped file takes its edges with it",
    );
  });

  it("counts an oversized file toward the importance of what it imports", () => {
    // hub.ts is imported by app, util, lib/index and big — the last of which the old
    // parser lost, silently understating hub's centrality.
    assert.equal(nodeFor("hub.ts").metrics.inDegree, 4);
  });

  it("carries parse failures through into the stats", async () => {
    // The fix removed the only known cause, so the reporting path is exercised
    // directly — otherwise a future regression would have nothing asserting on it.
    const { buildGraph } = await import("../src/graph/build.js");
    const built = buildGraph({
      files: [],
      parsed: new Map(),
      resolver: await (await import("../src/graph/resolve.js")).ImportResolver.create(
        fixture.root,
        [],
        [],
      ),
      churn: new Map(),
      churnAvailable: false,
      parseFailures: [{ path: "huge.ts", reason: "Invalid argument" }],
    });

    assert.equal(built.stats.parseFailures, 1);
  });

  it("emits a graph with the documented shape", () => {
    assert.equal(graph.version, 2);
    assert.ok(Date.parse(graph.generatedAt) > 0);
    assert.equal(graph.stats.fileCount, graph.nodes.length);
    assert.equal(graph.stats.edgeCount, graph.edges.length);
    for (const edge of graph.edges) {
      assert.ok(graph.nodes.some((n) => n.id === edge.from), `dangling edge from ${edge.from}`);
      assert.ok(graph.nodes.some((n) => n.id === edge.to), `dangling edge to ${edge.to}`);
    }
  });
});
