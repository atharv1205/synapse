import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { analyze } from "../src/analyze.js";
import { goPackageName, parseFile } from "../src/parse/extract.js";
import { signatureOf } from "../src/summarize/prompt.js";
import type { FunctionNode, RepoGraph } from "../src/types.js";

describe("parseFile — Java", () => {
  const source = `
package com.acme.app;

import com.acme.store.Store;
import static com.acme.util.Strings.trim;
import com.acme.model.*;
import java.util.List;

public class App extends Base implements Runnable {
  private final Store store = new Store();

  public App() {}

  @Override
  public void run() {
    List<Item> items = store.load();
    trim(Helper.name());
    log();
  }

  private void log() {}

  static class Inner {}
  interface Listener {}
  enum Mode { ON, OFF }
}
`;
  const parsed = parseFile("src/main/java/com/acme/app/App.java", source, "java");

  it("parses without syntax errors", () => {
    assert.equal(parsed.hasErrors, false);
  });

  it("extracts single-type, static and wildcard imports", () => {
    const explicit = parsed.imports.filter((i) => !i.implicit).map((i) => i.specifier);
    assert.deepEqual(explicit, ["com.acme.store.Store", "com.acme.util.Strings.trim", "com.acme.model.*", "java.util.List"]);
    assert.deepEqual(parsed.imports[0]?.names, [{ local: "Store", imported: "Store" }]);
    assert.deepEqual(parsed.imports[1]?.names, [{ local: "trim", imported: "trim" }]);
  });

  it("gives wildcard imports and the own package the types the file uses", () => {
    const wildcard = parsed.imports.find((i) => i.specifier === "com.acme.model.*");
    const own = parsed.imports.find((i) => i.implicit);
    assert.equal(own?.specifier, "com.acme.app.*");
    // Imported by name or declared here means no package needed. Item, Base and Helper do
    // need one.
    for (const uses of [wildcard?.uses, own?.uses]) {
      assert.ok(uses, "carries uses");
      assert.ok(uses.includes("Item") && uses.includes("Base") && uses.includes("Helper"), String(uses));
      assert.ok(!uses.includes("Store") && !uses.includes("List") && !uses.includes("Inner"), String(uses));
    }
  });

  it("extracts classes, interfaces, enums, constructors and methods", () => {
    const names = parsed.symbols.map((s) => `${s.kind}:${s.qualifiedName}`);
    for (const expected of [
      "class:App",
      "method:App.App",
      "method:App.run",
      "method:App.log",
      "class:App.Inner",
      "class:App.Listener",
      "class:App.Mode",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(", ")}`);
    }
  });

  it("marks public declarations as exported", () => {
    const exported = (name: string) => parsed.symbols.find((s) => s.qualifiedName === name)?.exported;
    assert.equal(exported("App"), true);
    assert.equal(exported("App.run"), true);
    assert.equal(exported("App.log"), false);
  });

  it("records method calls and constructor calls in their enclosing method", () => {
    const inRun = parsed.calls.filter((c) => c.enclosing?.endsWith("#App.run")).map((c) => c.callee);
    assert.deepEqual(inRun.sort(), ["load", "log", "name", "trim"]);
    assert.ok(parsed.calls.some((c) => c.callee === "Store"), "new Store() calls Store's constructor");
  });

  it("takes a signature from below a method's annotations", () => {
    const run = parsed.symbols.find((s) => s.qualifiedName === "App.run")!;
    const signature = signatureOf(run as unknown as FunctionNode, source.split("\n"));
    assert.equal(signature, "public void run()");
  });
});

describe("parseFile — Go", () => {
  const source = `package server

import (
	"fmt"
	st "github.com/acme/app/internal/store"
	"github.com/acme/app/internal/config/v2"
	_ "github.com/acme/app/internal/plugins"
)

type Server struct {
	db  *st.DB
	cfg config.Options
}

type Handler interface{ Serve() }

func New() *Server {
	return &Server{db: st.Open(), cfg: config.Load()}
}

func (s *Server) Start() error {
	fmt.Println("starting")
	listen(s)
	return nil
}

func helper() {}
`;
  const parsed = parseFile("internal/server/server.go", source, "go");

  it("parses without syntax errors", () => {
    assert.equal(parsed.hasErrors, false);
  });

  it("binds each import to its alias or package name", () => {
    const bySpecifier = new Map(parsed.imports.map((i) => [i.specifier, i]));
    assert.deepEqual(bySpecifier.get("fmt")?.names, [{ local: "fmt", imported: "*" }]);
    assert.deepEqual(bySpecifier.get("github.com/acme/app/internal/store")?.names, [{ local: "st", imported: "*" }]);
    // A major version suffix isn't the package name.
    assert.deepEqual(bySpecifier.get("github.com/acme/app/internal/config/v2")?.names, [
      { local: "config", imported: "*" },
    ]);
    assert.deepEqual(bySpecifier.get("github.com/acme/app/internal/plugins")?.names, []);
  });

  it("records the names used through each import", () => {
    const uses = (specifier: string) => parsed.imports.find((i) => i.specifier === specifier)?.uses;
    assert.deepEqual(uses("github.com/acme/app/internal/store"), ["DB", "Open"]);
    assert.deepEqual(uses("github.com/acme/app/internal/config/v2"), ["Load", "Options"]);
    assert.deepEqual(uses("fmt"), ["Println"]);
    assert.equal(uses("github.com/acme/app/internal/plugins"), undefined, "a blank import uses the whole package");
  });

  it("records bare names from the file's own package", () => {
    const own = parsed.imports.find((i) => i.implicit);
    assert.equal(own?.specifier, ".");
    assert.deepEqual(own?.uses, ["listen"]);
  });

  it("extracts functions, methods under their receiver, and types", () => {
    const names = parsed.symbols.map((s) => `${s.kind}:${s.qualifiedName}:${s.exported}`);
    for (const expected of [
      "function:New:true",
      "method:Server.Start:true",
      "function:helper:false",
      "class:Server:true",
      "class:Handler:true",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(", ")}`);
    }
  });

  it("names packages the way Go does", () => {
    assert.equal(goPackageName("github.com/acme/app/store"), "store");
    assert.equal(goPackageName("github.com/acme/app/store/v3"), "store");
    assert.equal(goPackageName("gopkg.in/yaml.v3"), "yaml");
    assert.equal(goPackageName("github.com/google/go-github"), "github");
  });
});

/** A small Maven-style Java project and a Go module side by side. */
const PROJECT: Record<string, string> = {
  "java/src/main/java/com/acme/app/App.java": `package com.acme.app;
import com.acme.store.Store;
import com.acme.model.*;
public class App {
  public void run() { new Store().save(new Item()); Config.load(); }
}`,
  "java/src/main/java/com/acme/app/Config.java": `package com.acme.app;
public class Config { public static void load() {} }`,
  "java/src/main/java/com/acme/app/Unused.java": `package com.acme.app;
public class Unused {}`,
  "java/src/main/java/com/acme/store/Store.java": `package com.acme.store;
public class Store { public void save(Object o) {} }`,
  "java/src/main/java/com/acme/model/Item.java": `package com.acme.model;
public class Item {}`,
  "java/src/main/java/com/acme/model/Order.java": `package com.acme.model;
public class Order {}`,
  "java/src/test/java/com/acme/app/AppTest.java": `package com.acme.app;
class AppTest { void test() { new App().run(); } }`,

  "go/go.mod": "module github.com/acme/app\n\ngo 1.22\n",
  "go/main.go": `package main
import (
	"fmt"
	"github.com/acme/app/store"
)
func main() { store.Open(); run(); fmt.Println() }`,
  "go/run.go": `package main
func run() {}`,
  "go/store/open.go": `package store
func Open() *DB { return &DB{} }`,
  "go/store/db.go": `package store
type DB struct{}`,
  "go/store/unrelated.go": `package store
func Close() {}`,
  "go/store/open_test.go": `package store
func TestOpen() { Open() }`,
  "go/vendor/github.com/other/lib/lib.go": `package lib
func Lib() {}`,
};

describe("analyze — Java and Go project", () => {
  let root: string;
  let graph: RepoGraph;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "synapse-langs-"));
    for (const [file, contents] of Object.entries(PROJECT)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), contents);
    }
    graph = await analyze(root, { skipChurn: true, skipSummarize: true, skipGitHub: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const hasEdge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to);
  const J = "java/src/main/java/com/acme/";

  it("finds Java and Go files, and skips vendored code", () => {
    assert.equal(graph.stats.byLanguage.java, 7);
    assert.equal(graph.stats.byLanguage.go, 6);
    assert.ok(!graph.nodes.some((n) => n.path.includes("vendor/")));
  });

  it("resolves a Java import to the class's file under its source root", () => {
    assert.ok(hasEdge(`${J}app/App.java`, `${J}store/Store.java`));
  });

  it("links a Java wildcard import only to the classes used", () => {
    assert.ok(hasEdge(`${J}app/App.java`, `${J}model/Item.java`));
    assert.ok(!hasEdge(`${J}app/App.java`, `${J}model/Order.java`));
  });

  it("links classes in the same package without an import, across source roots", () => {
    assert.ok(hasEdge(`${J}app/App.java`, `${J}app/Config.java`));
    assert.ok(!hasEdge(`${J}app/App.java`, `${J}app/Unused.java`));
    assert.ok(hasEdge("java/src/test/java/com/acme/app/AppTest.java", `${J}app/App.java`));
  });

  it("resolves a Go import through go.mod to the package files declaring what is used", () => {
    assert.ok(hasEdge("go/main.go", "go/store/open.go"));
    assert.ok(!hasEdge("go/main.go", "go/store/unrelated.go"));
    assert.ok(!hasEdge("go/main.go", "go/store/open_test.go"), "test files are not part of the package");
    // open.go uses DB from its own package.
    assert.ok(hasEdge("go/store/open.go", "go/store/db.go"));
  });

  it("links Go files of one package through the names they share", () => {
    assert.ok(hasEdge("go/main.go", "go/run.go"));
    assert.ok(hasEdge("go/store/open_test.go", "go/store/open.go"));
  });

  it("resolves Go calls across files, through imports and within a package", () => {
    const calls = new Set(graph.functionEdges.map((e) => `${e.from} -> ${e.to}`));
    assert.ok(calls.has("go/main.go#main -> go/store/open.go#Open"), [...calls].join("\n"));
    assert.ok(calls.has("go/main.go#main -> go/run.go#run"), [...calls].join("\n"));
  });

  it("counts the standard library as external, but not a package's own references", () => {
    assert.equal(graph.stats.parseFailures, 0);
    // Just fmt in main.go. Same-package references never count, matched or not.
    assert.equal(graph.stats.externalImports, 1);
  });
});
