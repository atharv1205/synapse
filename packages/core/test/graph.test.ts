import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { normalize, normalizeChurn } from "../src/graph/score.js";
import type { RepoGraph } from "../src/types.js";
import { createFixture, type Fixture } from "./fixture.js";

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
    assert.equal(hub.metrics.inDegree, 3, "hub is imported by app, util and lib/index");
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
    const hubFunctions = nodeFor("hub.ts").functions.map((f) => f.qualifiedName).sort();
    assert.deepEqual(hubFunctions, ["Registry", "Registry.add", "Registry.total", "sharedHelper"]);
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

  it("emits a graph with the documented shape", () => {
    assert.equal(graph.version, 1);
    assert.ok(Date.parse(graph.generatedAt) > 0);
    assert.equal(graph.stats.fileCount, graph.nodes.length);
    assert.equal(graph.stats.edgeCount, graph.edges.length);
    for (const edge of graph.edges) {
      assert.ok(graph.nodes.some((n) => n.id === edge.from), `dangling edge from ${edge.from}`);
      assert.ok(graph.nodes.some((n) => n.id === edge.to), `dangling edge to ${edge.to}`);
    }
  });
});
