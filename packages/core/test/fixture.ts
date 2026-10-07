import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

/**
 * A throwaway git repo with a known layout, built on disk so the tests run the real
 * walker, parser and `git log` instead of mocks.
 *
 * The dependency shape is on purpose:
 *   app.ts    -> util.ts, hub.ts, lib/index.ts
 *   util.ts   -> hub.ts
 *   lib/index.ts -> hub.ts
 *   orphan.ts -> (nothing, and nothing imports it)
 *   py/main.py -> py/helpers.py
 * so `hub.ts` has to come out as the most central file and `orphan.ts` the least.
 */
export interface Fixture {
  root: string;
  cleanup(): Promise<void>;
}

const FILES: Record<string, string> = {
  ".gitignore": [
    "generated/",
    "*.gen.ts",
    "!keep.gen.ts",
    "",
  ].join("\n"),

  "hub.ts": `
export function sharedHelper(value: number): number {
  return value * 2;
}

export class Registry {
  private items: number[] = [];
  add(item: number): void {
    this.items.push(item);
  }
  total(): number {
    return this.items.reduce((a, b) => a + sharedHelper(b), 0);
  }
}
`,

  // Imports "./hub.js", the NodeNext spelling that has to resolve back to hub.ts.
  "util.ts": `
import { sharedHelper } from "./hub.js";

export function double(n: number): number {
  return sharedHelper(n);
}

export const triple = (n: number): number => sharedHelper(n) + n;
`,

  // Imports "./lib" with no extension, which has to resolve to lib/index.ts.
  "app.ts": `
import { double, triple } from "./util.js";
import { Registry } from "./hub.js";
import { boot } from "./lib/index.js";
import express from "express";

export function main(): number {
  const registry = new Registry();
  registry.add(double(2));
  registry.add(triple(3));
  boot();
  return registry.total();
}
`,

  "lib/index.ts": `
import { sharedHelper } from "../hub.js";

export function boot(): number {
  return sharedHelper(1);
}
`,

  "orphan.ts": `
export function unused(): string {
  return "nobody imports me";
}
`,

  "py/helpers.py": `
def compute(value):
    return value * 2


class Accumulator:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(compute(item))
`,

  "py/main.py": `
import os
from .helpers import compute, Accumulator


def run(values):
    acc = Accumulator()
    for v in values:
        acc.add(compute(v))
    return os.getcwd()
`,

  // Should be skipped: it's in node_modules.
  "node_modules/pkg/index.ts": `export function vendored(): number { return 1; }`,

  // Should be skipped: .gitignore matches it.
  "generated/output.ts": `export const generated = true;`,
  "stale.gen.ts": `export const stale = true;`,

  // Should be KEPT: "!keep.gen.ts" un-ignores it.
  "keep.gen.ts": `export const kept = true;`,

  // Filled in below with a file bigger than tree-sitter's old string limit.
  "big.ts": "",
};

/**
 * tree-sitter's Node binding rejects strings of 32,768 chars or more, which used to make
 * every file over that size silently disappear from the graph. We generate this one just
 * past the limit so that bug can't come back unnoticed.
 */
export const BIG_FILE_MIN_CHARS = 32_768;

function buildBigFile(): string {
  const header = 'import { sharedHelper } from "./hub.js";\n\n';
  const body: string[] = [];
  let index = 0;

  // Padded with a comment so it crosses the limit by size, not by number of declarations.
  // Otherwise a few hundred functions could pass by accident.
  while (header.length + body.join("").length <= BIG_FILE_MIN_CHARS + 2_000) {
    body.push(
      `// filler to push this file past the parser's old ceiling ${"-".repeat(40)}\n` +
        `export function bulky${index}(value: number): number {\n` +
        `  return sharedHelper(value) + ${index};\n` +
        `}\n\n`,
    );
    index++;
  }

  // One easy-to-spot declaration right at the end, so we notice if the parse got cut
  // short.
  body.push("export function lastDeclaration(): number {\n  return sharedHelper(1);\n}\n");
  return header + body.join("");
}

FILES["big.ts"] = buildBigFile();

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "synapse-fixture-"));

  for (const [relPath, contents] of Object.entries(FILES)) {
    const abs = path.join(root, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents.trimStart(), "utf8");
  }

  const git = simpleGit(root);
  await git.init();
  // Local identity so commits work on machines without a global git config.
  await git.addConfig("user.email", "fixture@example.com");
  await git.addConfig("user.name", "Fixture");
  await git.addConfig("commit.gpgsign", "false");

  // Three commits touch hub.ts and one touches app.ts, so their churn is clearly
  // different and the test can check the order.
  await git.add(".");
  await git.commit("initial");

  for (let i = 0; i < 2; i++) {
    await writeFile(path.join(root, "hub.ts"), `${FILES["hub.ts"]!.trimStart()}\n// revision ${i}\n`);
    await git.add("hub.ts");
    await git.commit(`touch hub ${i}`);
  }

  await writeFile(path.join(root, "app.ts"), `${FILES["app.ts"]!.trimStart()}\n// revised\n`);
  await git.add("app.ts");
  await git.commit("touch app");

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
