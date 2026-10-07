import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
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
  java: Java,
  go: Go,
};

/**
 * Spinning up a Parser and loading a grammar isn't cheap, so keep one per language and
 * reuse it for every file.
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
 * How much source we hand tree-sitter per callback. Any size works, this one just keeps
 * the number of calls low.
 */
const READ_CHUNK = 16_384;

/**
 * Parse through tree-sitter's callback input instead of passing the whole string.
 *
 * The Node binding throws a bare "Invalid argument" for strings of 32,768 chars or more.
 * That quietly dropped every file over 32KB (515 of 18,851 in home-assistant/core), and
 * those tend to be the biggest, most imported files, so the importance scores were all
 * off. The callback form doesn't have that limit.
 *
 * We use it for every file, not just big ones. It's no slower (measured on a 13KB file),
 * gives the same tree, and means there's no size threshold to get wrong. `index` is in
 * UTF-16 code units, same as `slice`, so multi-byte characters split across chunks are
 * fine.
 */
export function parseSource(source: string, language: Language): SyntaxNode {
  return parserFor(language).parse((index: number) =>
    index < source.length ? source.slice(index, index + READ_CHUNK) : null,
  ).rootNode;
}

/** Depth-first walk over every named node. */
export function walkTree(root: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    // Push in reverse so children come out left to right.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** Strip the quotes off a string literal node's text. */
export function stringLiteralValue(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  const text = node.text;
  if (text.length >= 2 && /^['"`]/.test(text)) return text.slice(1, -1);
  return text;
}
