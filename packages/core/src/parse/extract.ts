import type { FunctionSymbol, Language } from "../types.js";
import { parseSource, stringLiteralValue, type SyntaxNode } from "./parser.js";

/** A name bound locally by an import, and the name it refers to in the source module. */
export interface ImportedName {
  local: string;
  /** `*` for namespace imports, `default` for default imports. */
  imported: string;
}

export interface ImportRef {
  /**
   * The raw module specifier, e.g. `./foo`, `react`, `pkg.mod`, `com.acme.Foo`,
   * `github.com/acme/app/store`. Java wildcards end in `.*`; `.` stands for the file's
   * own Go package.
   */
  specifier: string;
  kind: "esm" | "require" | "dynamic" | "python" | "java" | "go";
  names: ImportedName[];
  line: number;
  /**
   * For an import that names a package rather than a file (a Java wildcard, a Go
   * package, or the file's own package), the names the file uses from it. The graph
   * links only to the package's files that declare one of them.
   */
  uses?: string[];
  /**
   * True for a dependency the language implies without an import statement: Java and Go
   * files see their own package's declarations. Never counted as an external import.
   */
  implicit?: boolean;
}

/** A call site, attributed to the function that encloses it. */
export interface CallRef {
  /** The callee's simple name: `foo` for `foo()`, `bar` for `obj.bar()`. */
  callee: string;
  /** Id of the enclosing function symbol; undefined for module-level code. */
  enclosing?: string;
  line: number;
}

export interface ParsedFile {
  path: string;
  language: Language;
  loc: number;
  imports: ImportRef[];
  symbols: FunctionSymbol[];
  calls: CallRef[];
  /** True when tree-sitter reported syntax errors; the results are best-effort. */
  hasErrors: boolean;
}

/** Mutable state threaded through the recursive descent. */
interface Context {
  /** Enclosing class names, outermost first, used to build qualified names. */
  classStack: string[];
  /** Id of the nearest enclosing function, for attributing call sites. */
  enclosing?: string;
  /** Whether the current declaration sits under an `export`. */
  exported: boolean;
}

const ROOT_CONTEXT: Context = { classStack: [], exported: false };

export function parseFile(path: string, source: string, language: Language): ParsedFile {
  const root = parseSource(source, language);
  const result: ParsedFile = {
    path,
    language,
    loc: source.length === 0 ? 0 : source.split("\n").length,
    imports: [],
    symbols: [],
    calls: [],
    hasErrors: root.hasError,
  };

  if (language === "python") {
    visitPython(root, ROOT_CONTEXT, result);
  } else if (language === "java") {
    extractJava(root, result);
  } else if (language === "go") {
    extractGo(root, result);
  } else {
    visitJs(root, ROOT_CONTEXT, result);
  }

  return result;
}

function recordSymbol(
  result: ParsedFile,
  node: SyntaxNode,
  name: string,
  kind: FunctionSymbol["kind"],
  ctx: Context,
): FunctionSymbol {
  const qualifiedName = [...ctx.classStack, name].join(".");
  const symbol: FunctionSymbol = {
    id: `${result.path}#${qualifiedName}`,
    name,
    qualifiedName,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported: ctx.exported,
    importance: 0,
  };
  result.symbols.push(symbol);
  return symbol;
}

function visitChildren(node: SyntaxNode, ctx: Context, result: ParsedFile, visit: Visitor): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) visit(child, ctx, result);
  }
}

type Visitor = (node: SyntaxNode, ctx: Context, result: ParsedFile) => void;

// ---------------------------------------------------------------------------
// JavaScript / TypeScript / TSX
// ---------------------------------------------------------------------------

/** Pulls the local/imported name pairs out of an `import_clause`. */
function jsImportedNames(clause: SyntaxNode | null): ImportedName[] {
  if (!clause) return [];
  const names: ImportedName[] = [];

  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i);
    if (!child) continue;

    if (child.type === "identifier") {
      names.push({ local: child.text, imported: "default" });
    } else if (child.type === "namespace_import") {
      const alias = child.namedChild(child.namedChildCount - 1);
      if (alias) names.push({ local: alias.text, imported: "*" });
    } else if (child.type === "named_imports") {
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (!spec || spec.type !== "import_specifier") continue;
        const imported = spec.childForFieldName("name")?.text;
        const alias = spec.childForFieldName("alias")?.text;
        if (imported) names.push({ local: alias ?? imported, imported });
      }
    }
  }

  return names;
}

function visitJs(node: SyntaxNode, ctx: Context, result: ParsedFile): void {
  switch (node.type) {
    case "import_statement": {
      const specifier = stringLiteralValue(node.childForFieldName("source"));
      if (specifier) {
        const clause = node.namedChildren.find((c) => c.type === "import_clause") ?? null;
        result.imports.push({
          specifier,
          kind: "esm",
          names: jsImportedNames(clause),
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    case "export_statement": {
      // `export ... from "x"` is both a dependency and a re-export.
      const specifier = stringLiteralValue(node.childForFieldName("source"));
      if (specifier) {
        result.imports.push({
          specifier,
          kind: "esm",
          names: [],
          line: node.startPosition.row + 1,
        });
      }
      // Anything declared here is exported; recurse with that flag set.
      visitChildren(node, { ...ctx, exported: true }, result, visitJs);
      return;
    }

    case "call_expression": {
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");

      if (callee && (callee.text === "require" || callee.type === "import")) {
        const specifier = stringLiteralValue(args?.namedChild(0) ?? null);
        if (specifier) {
          result.imports.push({
            specifier,
            kind: callee.type === "import" ? "dynamic" : "require",
            names: [],
            line: node.startPosition.row + 1,
          });
        }
      } else if (callee) {
        const name =
          callee.type === "identifier"
            ? callee.text
            : callee.type === "member_expression"
              ? callee.childForFieldName("property")?.text
              : undefined;
        if (name) {
          result.calls.push({ callee: name, enclosing: ctx.enclosing, line: node.startPosition.row + 1 });
        }
      }

      visitChildren(node, ctx, result, visitJs);
      return;
    }

    case "class_declaration":
    case "class": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const symbol = recordSymbol(result, node, name, "class", ctx);
      visitChildren(
        node,
        { classStack: [...ctx.classStack, name], enclosing: symbol.id, exported: false },
        result,
        visitJs,
      );
      return;
    }

    case "function_declaration":
    case "generator_function_declaration": {
      const name = node.childForFieldName("name")?.text ?? "default";
      const symbol = recordSymbol(result, node, name, "function", ctx);
      visitChildren(node, { ...ctx, enclosing: symbol.id, exported: false }, result, visitJs);
      return;
    }

    case "method_definition": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const symbol = recordSymbol(result, node, name, "method", ctx);
      visitChildren(node, { ...ctx, enclosing: symbol.id, exported: false }, result, visitJs);
      return;
    }

    case "variable_declarator": {
      // `const foo = () => {}` and `const foo = function () {}` read as declarations.
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      if (name && value && (value.type === "arrow_function" || value.type === "function_expression")) {
        const symbol = recordSymbol(result, node, name, "function", ctx);
        visitChildren(value, { ...ctx, enclosing: symbol.id, exported: false }, result, visitJs);
        return;
      }
      break;
    }
  }

  visitChildren(node, ctx, result, visitJs);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/** Renders `module_name` for both absolute (`a.b`) and relative (`..a.b`) imports. */
function pythonModuleName(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (node.type === "relative_import") {
    const prefix = node.namedChildren.find((c) => c.type === "import_prefix")?.text ?? "";
    const rest = node.namedChildren.find((c) => c.type === "dotted_name")?.text ?? "";
    return `${prefix}${rest}`;
  }
  return node.text;
}

/** A `dotted_name` or `aliased_import` yields one local binding. */
function pythonBinding(node: SyntaxNode): ImportedName | undefined {
  if (node.type === "aliased_import") {
    const name = node.childForFieldName("name")?.text;
    const alias = node.childForFieldName("alias")?.text;
    if (name) return { local: alias ?? name, imported: name };
    return undefined;
  }
  if (node.type === "dotted_name") {
    const parts = node.text.split(".");
    return { local: parts[parts.length - 1]!, imported: node.text };
  }
  if (node.type === "wildcard_import") return { local: "*", imported: "*" };
  return undefined;
}

function visitPython(node: SyntaxNode, ctx: Context, result: ParsedFile): void {
  switch (node.type) {
    case "import_statement": {
      // `import a.b, c as d` — each child is its own module dependency.
      for (const child of node.namedChildren) {
        const binding = pythonBinding(child);
        const specifier =
          child.type === "aliased_import"
            ? child.childForFieldName("name")?.text
            : child.text;
        if (!specifier) continue;
        result.imports.push({
          specifier,
          kind: "python",
          names: binding ? [binding] : [],
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    case "import_from_statement": {
      const specifier = pythonModuleName(node.childForFieldName("module_name"));
      if (!specifier) return;
      const moduleNode = node.childForFieldName("module_name");
      const names: ImportedName[] = [];
      for (const child of node.namedChildren) {
        if (child.id === moduleNode?.id) continue;
        const binding = pythonBinding(child);
        if (binding) names.push(binding);
      }
      result.imports.push({ specifier, kind: "python", names, line: node.startPosition.row + 1 });
      return;
    }

    case "call": {
      const callee = node.childForFieldName("function");
      const name =
        callee?.type === "identifier"
          ? callee.text
          : callee?.type === "attribute"
            ? callee.childForFieldName("attribute")?.text
            : undefined;
      if (name) {
        result.calls.push({ callee: name, enclosing: ctx.enclosing, line: node.startPosition.row + 1 });
      }
      visitChildren(node, ctx, result, visitPython);
      return;
    }

    case "class_definition": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      // Python has no export keyword; the leading-underscore convention stands in.
      const symbol = recordSymbol(result, node, name, "class", { ...ctx, exported: !name.startsWith("_") });
      visitChildren(
        node,
        { classStack: [...ctx.classStack, name], enclosing: symbol.id, exported: false },
        result,
        visitPython,
      );
      return;
    }

    case "function_definition": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const kind = ctx.classStack.length > 0 ? "method" : "function";
      const symbol = recordSymbol(result, node, name, kind, { ...ctx, exported: !name.startsWith("_") });
      visitChildren(node, { ...ctx, enclosing: symbol.id, exported: false }, result, visitPython);
      return;
    }
  }

  visitChildren(node, ctx, result, visitPython);
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

/** Names of types a Java file mentions, for matching against packages it sees whole. */
interface JavaState {
  types: Set<string>;
}

function javaIsPublic(node: SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  return modifiers ? /\bpublic\b/.test(modifiers.text) : false;
}

/**
 * Java imports name classes, not files, but the convention of one top-level class per
 * file named after it lets `com.acme.Foo` find `…/com/acme/Foo.java`. Wildcard imports
 * and the file's own package name no file, so they carry the type names the file uses,
 * and the graph links to whichever of the package's files declare them.
 */
function extractJava(root: SyntaxNode, result: ParsedFile): void {
  const state: JavaState = { types: new Set() };
  let pkg: string | undefined;
  let pkgLine = 1;

  for (const child of root.namedChildren) {
    if (child.type === "package_declaration") {
      pkg = child.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
      pkgLine = child.startPosition.row + 1;
    } else if (child.type === "import_declaration") {
      const target = child.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
      if (!target) continue;
      const wildcard = child.namedChildren.some((c) => c.type === "asterisk");
      const line = child.startPosition.row + 1;
      if (wildcard) {
        result.imports.push({ specifier: `${target.text}.*`, kind: "java", names: [], line });
      } else {
        const name = target.text.split(".").pop()!;
        result.imports.push({ specifier: target.text, kind: "java", names: [{ local: name, imported: name }], line });
      }
    }
  }

  visitJava(root, ROOT_CONTEXT, result, state);

  // Types declared here or imported by name need no package to find them.
  const known = new Set([
    ...result.symbols.filter((s) => s.kind === "class").map((s) => s.name),
    ...result.imports.flatMap((i) => i.names.map((n) => n.local)),
  ]);
  const uses = [...state.types].filter((t) => !known.has(t)).sort();
  for (const ref of result.imports) {
    if (ref.specifier.endsWith(".*")) ref.uses = uses;
  }
  if (uses.length > 0) {
    result.imports.push({
      // The default package is the file's own directory, which `*` stands for.
      specifier: pkg ? `${pkg}.*` : "*",
      kind: "java",
      names: [],
      line: pkgLine,
      uses,
      implicit: true,
    });
  }
}

function visitJava(node: SyntaxNode, ctx: Context, result: ParsedFile, state: JavaState): void {
  const visit: Visitor = (child, childCtx, res) => visitJava(child, childCtx, res, state);

  if (JAVA_TYPE_DECLARATIONS.has(node.type)) {
    const name = node.childForFieldName("name")?.text;
    if (name) {
      const symbol = recordSymbol(result, node, name, "class", { ...ctx, exported: javaIsPublic(node) });
      visitChildren(node, { classStack: [...ctx.classStack, name], enclosing: symbol.id, exported: false }, result, visit);
      return;
    }
  }

  switch (node.type) {
    case "package_declaration":
    case "import_declaration":
      return;

    case "method_declaration":
    case "constructor_declaration":
    case "compact_constructor_declaration": {
      const name = node.childForFieldName("name")?.text ?? ctx.classStack[ctx.classStack.length - 1];
      if (!name) break;
      const symbol = recordSymbol(result, node, name, "method", { ...ctx, exported: javaIsPublic(node) });
      visitChildren(node, { ...ctx, enclosing: symbol.id, exported: false }, result, visit);
      return;
    }

    case "type_identifier":
      state.types.add(node.text);
      return;

    case "method_invocation": {
      const name = node.childForFieldName("name")?.text;
      if (name) result.calls.push({ callee: name, enclosing: ctx.enclosing, line: node.startPosition.row + 1 });
      // `Helper.run()` names the class through a plain identifier, not a type.
      const object = node.childForFieldName("object");
      if (object?.type === "identifier" && /^[A-Z]/.test(object.text)) state.types.add(object.text);
      break;
    }

    case "field_access": {
      const object = node.childForFieldName("object");
      if (object?.type === "identifier" && /^[A-Z]/.test(object.text)) state.types.add(object.text);
      break;
    }

    case "object_creation_expression": {
      // `new Foo()` calls Foo's constructor, which is declared under Foo's own name.
      const type = node.childForFieldName("type");
      const name = type?.type === "generic_type" ? type.namedChild(0)?.text : type?.text;
      if (name && /^\w+$/.test(name)) {
        result.calls.push({ callee: name, enclosing: ctx.enclosing, line: node.startPosition.row + 1 });
      }
      break;
    }
  }

  visitChildren(node, ctx, result, visit);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/**
 * The name an import binds when it has no alias: the package name, which by convention
 * is the last path segment, skipping a major-version suffix (`…/v2`) and the forms
 * `gopkg.in/yaml.v3` and `go-github` use.
 */
export function goPackageName(importPath: string): string {
  const parts = importPath.split("/");
  let last = parts.pop() ?? importPath;
  if (/^v\d+$/.test(last) && parts.length > 0) last = parts.pop()!;
  return last.replace(/\.v\d+$/, "").replace(/^go-/, "").replace(/[-.]/g, "_");
}

/** Go's predeclared types and functions, which no file in the repository declares. */
const GO_BUILTINS = new Set(
  (
    "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 " +
    "rune string uint uint8 uint16 uint32 uint64 uintptr append cap clear close complex copy delete " +
    "imag len make max min new panic print println real recover"
  ).split(" "),
);

/** Names a Go file uses: qualified through each import's local name, and bare. */
interface GoState {
  qualified: Map<string, Set<string>>;
  bare: Set<string>;
}

/**
 * Go imports name packages, which are directories. Each import carries the names the
 * file selects through it (`store.Open`, `store.Item`), and the file's own package,
 * which it sees without importing, carries the bare names it uses, so the graph can
 * link to the files in a package that declare what is used rather than to all of them.
 */
function extractGo(root: SyntaxNode, result: ParsedFile): void {
  const state: GoState = { qualified: new Map(), bare: new Set() };
  /** Local name -> the import that binds it. */
  const locals = new Map<string, ImportRef>();

  for (const decl of root.namedChildren) {
    if (decl.type !== "import_declaration") continue;
    const specs = decl.descendantsOfType("import_spec");
    for (const spec of specs) {
      const importPath = stringLiteralValue(spec.childForFieldName("path"));
      if (!importPath) continue;
      const alias = spec.childForFieldName("name")?.text;
      const local = alias ?? goPackageName(importPath);
      const ref: ImportRef = {
        specifier: importPath,
        kind: "go",
        names: alias === "_" || alias === "." ? [] : [{ local, imported: "*" }],
        line: spec.startPosition.row + 1,
      };
      result.imports.push(ref);
      // A blank or dot import uses the package without naming it; it links to all of it.
      if (alias !== "_" && alias !== ".") locals.set(local, ref);
    }
  }

  visitGo(root, ROOT_CONTEXT, result, state);

  for (const [local, ref] of locals) {
    ref.uses = [...(state.qualified.get(local) ?? [])].sort();
  }

  const declared = new Set(result.symbols.map((s) => s.name));
  const bare = [...state.bare]
    .filter((name) => !declared.has(name) && !locals.has(name) && !GO_BUILTINS.has(name))
    .sort();
  if (bare.length > 0) {
    result.imports.push({ specifier: ".", kind: "go", names: [], line: 1, uses: bare, implicit: true });
  }
}

/** The receiver type of a method: `T` for both `(t T)` and `(t *T)`, generics dropped. */
function goReceiverType(node: SyntaxNode): string | undefined {
  const receiver = node.childForFieldName("receiver");
  const type = receiver?.descendantsOfType("type_identifier")[0];
  return type?.text;
}

function visitGo(node: SyntaxNode, ctx: Context, result: ParsedFile, state: GoState): void {
  const visit: Visitor = (child, childCtx, res) => visitGo(child, childCtx, res, state);
  const exported = (name: string) => /^[A-Z]/.test(name);

  switch (node.type) {
    case "import_declaration":
    case "package_clause":
      return;

    case "function_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const symbol = recordSymbol(result, node, name, "function", { ...ctx, exported: exported(name) });
      visitChildren(node, { ...ctx, enclosing: symbol.id, exported: false }, result, visit);
      return;
    }

    case "method_declaration": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      const receiver = goReceiverType(node);
      const methodCtx: Context = {
        classStack: receiver ? [receiver] : [],
        enclosing: ctx.enclosing,
        exported: exported(name),
      };
      const symbol = recordSymbol(result, node, name, "method", methodCtx);
      // The receiver's type lives in this package, so it counts as a bare use.
      if (receiver) state.bare.add(receiver);
      visitChildren(node, { ...methodCtx, enclosing: symbol.id, exported: false }, result, visit);
      return;
    }

    case "type_spec": {
      const name = node.childForFieldName("name")?.text;
      if (!name) break;
      recordSymbol(result, node, name, "class", { ...ctx, exported: exported(name) });
      // Field and method types inside still count as uses.
      const type = node.childForFieldName("type");
      if (type) visit(type, ctx, result);
      return;
    }

    case "call_expression": {
      const callee = node.childForFieldName("function");
      if (callee?.type === "identifier") {
        result.calls.push({ callee: callee.text, enclosing: ctx.enclosing, line: node.startPosition.row + 1 });
        state.bare.add(callee.text);
      } else if (callee?.type === "selector_expression") {
        const field = callee.childForFieldName("field")?.text;
        if (field) result.calls.push({ callee: field, enclosing: ctx.enclosing, line: node.startPosition.row + 1 });
      }
      break;
    }

    case "selector_expression": {
      const operand = node.childForFieldName("operand");
      const field = node.childForFieldName("field")?.text;
      if (operand?.type === "identifier" && field) {
        let names = state.qualified.get(operand.text);
        if (!names) state.qualified.set(operand.text, (names = new Set()));
        names.add(field);
      }
      break;
    }

    case "qualified_type": {
      const pkg = node.childForFieldName("package")?.text;
      const name = node.childForFieldName("name")?.text;
      if (pkg && name) {
        let names = state.qualified.get(pkg);
        if (!names) state.qualified.set(pkg, (names = new Set()));
        names.add(name);
      }
      return;
    }

    case "type_identifier":
      state.bare.add(node.text);
      return;
  }

  visitChildren(node, ctx, result, visit);
}
