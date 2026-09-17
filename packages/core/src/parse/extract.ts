import type { FunctionSymbol, Language } from "../types.js";
import { parseSource, stringLiteralValue, type SyntaxNode } from "./parser.js";

/** A name bound locally by an import, and the name it refers to in the source module. */
export interface ImportedName {
  local: string;
  /** `*` for namespace imports, `default` for default imports. */
  imported: string;
}

export interface ImportRef {
  /** The raw module specifier, e.g. `./foo`, `react`, `pkg.mod`. */
  specifier: string;
  kind: "esm" | "require" | "dynamic" | "python";
  names: ImportedName[];
  line: number;
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
