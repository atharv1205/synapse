import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFile } from "../src/parse/extract.js";

describe("parseFile — JavaScript/TypeScript", () => {
  const source = `
import React, { useState as useS } from "react";
import * as path from "node:path";
import { helper } from "./util/helper.js";
export { thing } from "./thing.js";
const legacy = require("./legacy");

export function topLevel(a: number) { return helper(a) + inner(); }
function inner() { return 1; }
export const arrowFn = (x: number) => topLevel(x);

export class Widget {
  render() { return this.paint(); }
  paint() { return 0; }
}
`;
  const parsed = parseFile("demo.ts", source, "typescript");

  it("parses without syntax errors", () => {
    assert.equal(parsed.hasErrors, false);
  });

  it("extracts every import form", () => {
    const specifiers = parsed.imports.map((i) => i.specifier);
    assert.deepEqual(specifiers, ["react", "node:path", "./util/helper.js", "./thing.js", "./legacy"]);
    assert.equal(parsed.imports.find((i) => i.specifier === "./legacy")?.kind, "require");
  });

  it("records local bindings, including aliases and namespaces", () => {
    const react = parsed.imports.find((i) => i.specifier === "react");
    assert.deepEqual(react?.names, [
      { local: "React", imported: "default" },
      { local: "useS", imported: "useState" },
    ]);
    assert.deepEqual(parsed.imports.find((i) => i.specifier === "node:path")?.names, [
      { local: "path", imported: "*" },
    ]);
  });

  it("extracts functions, arrow functions, classes and methods", () => {
    const byName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    assert.equal(byName.get("topLevel")?.kind, "function");
    assert.equal(byName.get("arrowFn")?.kind, "function");
    assert.equal(byName.get("Widget")?.kind, "class");
    assert.equal(byName.get("Widget.render")?.kind, "method");
    assert.equal(byName.get("Widget.paint")?.kind, "method");
  });

  it("marks exported declarations", () => {
    const byName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    assert.equal(byName.get("topLevel")?.exported, true);
    assert.equal(byName.get("inner")?.exported, false);
  });

  it("attributes call sites to their enclosing function", () => {
    const inTopLevel = parsed.calls.filter((c) => c.enclosing === "demo.ts#topLevel");
    assert.deepEqual(inTopLevel.map((c) => c.callee).sort(), ["helper", "inner"]);
    assert.equal(parsed.calls.find((c) => c.callee === "paint")?.enclosing, "demo.ts#Widget.render");
  });
});

describe("parseFile — Python", () => {
  const source = `
import os
import os.path as p
from .relative import thing
from ..pkg.deep import a, b as c

def top_level(x):
    return helper(x) + _inner()

def _inner():
    return 1

class Widget:
    def render(self):
        return self.paint()

    def paint(self):
        return os.getcwd()
`;
  const parsed = parseFile("demo.py", source, "python");

  it("parses without syntax errors", () => {
    assert.equal(parsed.hasErrors, false);
  });

  it("extracts plain, aliased and relative imports", () => {
    const specifiers = parsed.imports.map((i) => i.specifier);
    assert.deepEqual(specifiers, ["os", "os.path", ".relative", "..pkg.deep"]);
  });

  it("preserves the leading dots that set a relative import's level", () => {
    assert.equal(parsed.imports[3]?.specifier, "..pkg.deep");
  });

  it("records aliased names", () => {
    assert.deepEqual(parsed.imports.find((i) => i.specifier === "..pkg.deep")?.names, [
      { local: "a", imported: "a" },
      { local: "c", imported: "b" },
    ]);
  });

  it("classifies methods separately from module-level functions", () => {
    const byName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    assert.equal(byName.get("top_level")?.kind, "function");
    assert.equal(byName.get("Widget")?.kind, "class");
    assert.equal(byName.get("Widget.render")?.kind, "method");
  });

  it("treats leading-underscore names as non-exported", () => {
    const byName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    assert.equal(byName.get("top_level")?.exported, true);
    assert.equal(byName.get("_inner")?.exported, false);
  });

  it("attributes call sites to their enclosing function", () => {
    assert.equal(parsed.calls.find((c) => c.callee === "paint")?.enclosing, "demo.py#Widget.render");
    assert.equal(parsed.calls.find((c) => c.callee === "getcwd")?.enclosing, "demo.py#Widget.paint");
  });
});
