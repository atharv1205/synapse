import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildClustering, clusterByFolder, type ClusterInput } from "../src/clusters.js";

let next = 0;
function file(path: string, importance = 0.1, position: [number, number, number] = [0, 0, 0]): ClusterInput {
  return { index: next++, path, importance, x: position[0], y: position[1], z: position[2] };
}

function files(paths: string[]): ClusterInput[] {
  next = 0;
  return paths.map((p) => file(p));
}

/** Every file ends up in exactly one cluster. */
function assertPartition(nodes: ClusterInput[], groups: Map<string, number[]>) {
  const seen = [...groups.values()].flat().sort((a, b) => a - b);
  assert.deepEqual(seen, nodes.map((n) => n.index).sort((a, b) => a - b));
}

describe("clusterByFolder", () => {
  it("groups files by folder, with a folder's own files beside its subfolders", () => {
    const nodes = files(["README.py", "src/app.ts", "src/main.ts", "src/lib/a.ts", "src/lib/b.ts", "tests/t.ts"]);
    const groups = clusterByFolder(nodes, { target: 10 });
    assertPartition(nodes, groups);
    assert.deepEqual([...groups.keys()].sort(), ["", "src", "src/lib", "tests"]);
    assert.equal(groups.get("src")!.length, 2, "src's direct files stay together");
  });

  it("stops at the target, splitting the largest groups first", () => {
    const nodes = files([
      ...Array.from({ length: 30 }, (_, i) => `big/m${i % 3}/f${i}.ts`),
      "small/a.ts",
      "small/b.ts",
    ]);
    const groups = clusterByFolder(nodes, { target: 4 });
    assertPartition(nodes, groups);
    assert.ok(groups.has("big/m0") && groups.has("big/m1") && groups.has("big/m2"), "the big folder split");
    assert.ok(groups.has("small"), "the small folder stayed whole");
  });

  it("walks down single-folder chains without spending clusters on them", () => {
    const nodes = files(["a/b/c/x/1.ts", "a/b/c/x/2.ts", "a/b/c/y/3.ts"]);
    const groups = clusterByFolder(nodes, { target: 5 });
    assert.deepEqual([...groups.keys()].sort(), ["a/b/c/x", "a/b/c/y"]);
  });

  it("folds a folder with too many subfolders into the largest few plus one overflow group", () => {
    // Like homeassistant/components: hundreds of integrations in one folder.
    const nodes = files([
      ...Array.from({ length: 300 }, (_, i) => `components/c${i}/__init__.py`),
      ...Array.from({ length: 20 }, (_, i) => `components/huge/f${i}.py`),
    ]);
    const groups = clusterByFolder(nodes, { target: 10, max: 20 });
    assertPartition(nodes, groups);
    assert.ok(groups.size <= 10, `${groups.size} clusters`);
    assert.ok(groups.has("components/huge"), "the largest subfolder keeps its own cluster");
    const overflow = [...groups.keys()].find((k) => /\/\+\d+$/.test(k));
    assert.ok(overflow?.startsWith("components/+"), String(overflow));
  });

  it("splits every giant folder, not only the first one it meets", () => {
    // Like home-assistant: components/ and tests/components/ both hold hundreds of
    // integrations, and the first one can't be allowed to use up the whole budget.
    const nodes = files([
      ...Array.from({ length: 600 }, (_, i) => `components/c${i % 200}/f${i}.py`),
      ...Array.from({ length: 500 }, (_, i) => `tests/components/c${i % 200}/t${i}.py`),
    ]);
    const groups = clusterByFolder(nodes, { target: 20, max: 40 });
    assertPartition(nodes, groups);
    assert.ok(groups.size <= 40, `${groups.size} clusters`);
    const keys = [...groups.keys()];
    assert.ok(keys.some((k) => /^components\/c\d+$/.test(k)), "components/ split");
    assert.ok(keys.some((k) => /^tests\/components\/c\d+$/.test(k)), "tests/components/ split too");
  });

  it("returns one cluster for a repository with every file in one folder", () => {
    const nodes = files(["a.ts", "b.ts", "c.ts"]);
    assert.deepEqual([...clusterByFolder(nodes).keys()], [""]);
  });
});

describe("buildClustering", () => {
  it("places each cluster at its files' centroid and colours it by its top file", () => {
    next = 0;
    const nodes = [
      file("src/a.ts", 0.2, [0, 0, 0]),
      file("src/b.ts", 0.9, [10, 0, 0]),
      file("lib/c.ts", 0.1, [0, 20, 0]),
    ];
    const { clusters } = buildClustering(nodes, [], { target: 5 });
    const src = clusters.find((c) => c.id === "src")!;
    assert.equal(src.x, 5);
    assert.equal(src.importance, 0.9);
    assert.equal(src.label, "src/");
    assert.equal(src.folded, 0);
  });

  it("counts the imports between clusters and drops those within one", () => {
    const nodes = files(["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts"]);
    const { clusters, edges, clusterOf } = buildClustering(
      nodes,
      [
        { from: 0, to: 2 },
        { from: 1, to: 3 },
        { from: 0, to: 1 },
        { from: 2, to: 0 },
      ],
      { target: 5 },
    );
    const src = clusters.findIndex((c) => c.id === "src");
    const lib = clusters.findIndex((c) => c.id === "lib");
    assert.equal(clusterOf[0], src);
    assert.deepEqual(edges.find((e) => e.from === src && e.to === lib)?.weight, 2);
    assert.deepEqual(edges.find((e) => e.from === lib && e.to === src)?.weight, 1);
    assert.ok(!edges.some((e) => e.from === e.to), "no edges within a cluster");
  });

  it("labels an overflow group with how many folders it holds", () => {
    const nodes = files(Array.from({ length: 50 }, (_, i) => `pkg/m${i}/f.py`));
    const { clusters } = buildClustering(nodes, [], { target: 6, max: 10 });
    const overflow = clusters.find((c) => c.folded > 0)!;
    assert.match(overflow.label, /^pkg\/ \+\d+ more$/);
    assert.equal(overflow.folder, "pkg");
  });

  it("tells same-named folders apart", () => {
    const nodes = files(["packages/core/src/a.ts", "packages/web/src/b.ts", "packages/core/test/c.ts"]);
    const labels = buildClustering(nodes, [], { target: 10 }).clusters.map((c) => c.label).sort();
    assert.deepEqual(labels, ["core/src/", "test/", "web/src/"]);
  });
});
