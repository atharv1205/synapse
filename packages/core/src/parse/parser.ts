import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScript from "tree-sitter-typescript";
import type { Language } from "../types.js";

export type SyntaxNode = Parser.SyntaxNode;

const GRAMMARS: Record<Language, unknown> = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
};

/**
 * Creating a Parser and loading a grammar is comparatively expensive, so we keep
 * one parser per language and reuse it across every file of that language.
 */
const pool = new Map<Language, Parser>();

function parserFor(language: Language): Parser {
  let parser = pool.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(GRAMMARS[language]);
    pool.set(language, parser);
  }
  return parser;
}

/**
 * How much source to hand tree-sitter per callback invocation. Any value works; this
 * is large enough to keep the call count low and small enough to stay cache-friendly.
 */
const READ_CHUNK = 16_384;

/**
 * Parses source via tree-sitter's callback input rather than by passing a string.
 *
 * The Node binding rejects a string of 32,768 characters or more with a bare
 * "Invalid argument", which silently cost us every file above 32KB — 515 of 18,851 in
 * home-assistant/core, and biased toward the largest and most depended-on files, so the
 * gap distorted every importance score. The callback form has no such limit.
 *
 * It is used for every file, not just large ones. Measured overhead against the string
 * form is nil (within noise on a 13KB file), the resulting tree is identical, and using
 * one path everywhere means there is no size threshold to get wrong. `index` counts
 * UTF-16 code units, which is exactly what `String.prototype.slice` takes, so
 * multi-byte characters and surrogate pairs straddling a chunk boundary are safe.
 */
export function parseSource(source: string, language: Language): SyntaxNode {
  return parserFor(language).parse((index: number) =>
    index < source.length ? source.slice(index, index + READ_CHUNK) : null,
  ).rootNode;
}

/** Depth-first walk over every named node, calling `visit` on each. */
export function walkTree(root: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    // Push in reverse so children are visited left-to-right.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** Strips the surrounding quotes from a tree-sitter string literal node's text. */
export function stringLiteralValue(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  const text = node.text;
  if (text.length >= 2 && /^['"`]/.test(text)) return text.slice(1, -1);
  return text;
}
