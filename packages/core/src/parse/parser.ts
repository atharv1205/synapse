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

export function parseSource(source: string, language: Language): SyntaxNode {
  return parserFor(language).parse(source).rootNode;
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
