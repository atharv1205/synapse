import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

/**
 * A throwaway git repo with a known shape, built on disk so the tests exercise the
 * real walker, the real parser and real `git log` rather than mocks.
 *
 * The dependency shape is deliberate:
 *   app.ts    -> util.ts, hub.ts, lib/index.ts
 *   util.ts   -> hub.ts
 *   lib/index.ts -> hub.ts
 *   orphan.ts -> (nothing, and nothing imports it)
 *   py/main.py -> py/helpers.py
 * so `hub.ts` must come out as the most central file and `orphan.ts` the least.
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

  // Imports "./hub.js" — the NodeNext spelling that must resolve back to hub.ts.
  "util.ts": `
import { sharedHelper } from "./hub.js";

export function double(n: number): number {
  return sharedHelper(n);
}

export const triple = (n: number): number => sharedHelper(n) + n;
`,

  // Imports "./lib" with no extension, which must resolve to lib/index.ts.
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

  // Must be skipped: inside node_modules.
  "node_modules/pkg/index.ts": `export function vendored(): number { return 1; }`,

  // Must be skipped: matched by .gitignore.
  "generated/output.ts": `export const generated = true;`,
  "stale.gen.ts": `export const stale = true;`,

  // Must be KEPT: negated by "!keep.gen.ts".
  "keep.gen.ts": `export const kept = true;`,
};

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "synapse-fixture-"));

  for (const [relPath, contents] of Object.entries(FILES)) {
    const abs = path.join(root, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents.trimStart(), "utf8");
  }

  const git = simpleGit(root);
  await git.init();
  // Local identity so the commits work on machines with no global git config.
  await git.addConfig("user.email", "fixture@example.com");
  await git.addConfig("user.name", "Fixture");
  await git.addConfig("commit.gpgsign", "false");

  // Three commits touching hub.ts and one touching app.ts, so churn is measurably
  // different between them and the test can assert on the ordering.
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
