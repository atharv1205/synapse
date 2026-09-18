import type { FileNode, FunctionSymbol } from "../types.js";
import type { JsonSchema } from "../llm/types.js";

/**
 * Bump when the prompt or schema changes in a way that makes old summaries stale.
 * Cached entries carry the version they were generated under and are re-generated
 * when it no longer matches.
 */
export const PROMPT_VERSION = 1;

/** How much of a file's source to send. Enough for context, small enough to stay fast. */
export const MAX_SOURCE_CHARS = 6_000;

/** How many of a file's functions get their own one-line summary. */
export const TOP_FUNCTIONS_PER_FILE = 3;

/** A function selected for summarisation, with the call count that got it selected. */
export interface RankedFunction {
  symbol: FunctionSymbol;
  callCount: number;
  signature: string;
}

export const SUMMARY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    functions: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, summary: { type: "string" } },
        required: ["name", "summary"],
      },
    },
  },
  required: ["summary", "functions"],
};

export interface SummaryResponse {
  summary: string;
  functions: Array<{ name: string; summary: string }>;
}

/**
 * Recovers a declaration's signature by taking the source line it starts on. This is
 * cheap and accurate for the common single-line case; multi-line parameter lists get
 * an ellipsis rather than a reconstructed signature, which is honest about the limit.
 */
export function signatureOf(symbol: FunctionSymbol, lines: string[]): string {
  const line = lines[symbol.startLine - 1]?.trim() ?? symbol.name;
  const cleaned = line.replace(/\s*\{\s*$/, "").replace(/\s*:\s*$/, "");
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117)}...`;
}

/** Keeps the head of a file, which holds the imports and the primary declarations. */
export function truncateSource(source: string, limit = MAX_SOURCE_CHARS): {
  text: string;
  truncated: boolean;
} {
  if (source.length <= limit) return { text: source, truncated: false };
  return { text: source.slice(0, limit), truncated: true };
}

function languageFence(language: FileNode["language"]): string {
  return language === "python" ? "python" : "typescript";
}

/**
 * Builds the prompt for one file. Includes why the file matters (its graph metrics),
 * what it declares (signatures), and what it actually says (a capped slice of source),
 * so the model can describe the file's role rather than just paraphrasing its code.
 */
export function buildFilePrompt(
  node: FileNode,
  source: string,
  ranked: RankedFunction[],
): string {
  const { metrics } = node;
  const { text, truncated } = truncateSource(source);
  const lines: string[] = [];

  lines.push(
    "You are documenting one file from a codebase that has been analysed into a dependency graph.",
    "",
    `File: ${node.path}`,
    `Language: ${node.language}`,
    "",
    "Why this file ranked as significant:",
    `- Imported by ${metrics.inDegree} other file(s) in this repo`,
    `- Imports ${metrics.outDegree} other file(s) in this repo`,
    `- Touched by ${metrics.churn} commit(s) in git history`,
    `- ${metrics.loc} lines long`,
    "",
  );

  const allSignatures = node.functions.map((fn) => {
    const marker = fn.exported ? " [exported]" : "";
    return `- ${fn.kind}: ${fn.qualifiedName}${marker}`;
  });

  if (allSignatures.length > 0) {
    lines.push(`Declarations in this file (${allSignatures.length}):`, ...allSignatures, "");
  } else {
    lines.push("This file declares no functions or classes (it may be types or constants only).", "");
  }

  if (ranked.length > 0) {
    lines.push("Summarise these functions specifically, chosen by how often they are called:");
    for (const { symbol, callCount, signature } of ranked) {
      lines.push(`- ${symbol.qualifiedName} (${callCount} resolved call site(s)): ${signature}`);
    }
    lines.push("");
  }

  lines.push(
    truncated
      ? `Source (first ${text.length} of ${source.length} characters):`
      : "Source:",
    "```" + languageFence(node.language),
    text,
    "```",
    "",
    "Respond with JSON only, matching this shape:",
    '  "summary": 1-3 sentences on what this file does and the role it plays in the codebase.',
    ranked.length > 0
      ? `  "functions": exactly ${ranked.length} entries, one per function listed above, each with its exact "name" and a single-sentence "summary".`
      : '  "functions": an empty array.',
    "",
    "Describe what the code actually does. Do not speculate about code you were not shown.",
  );

  return lines.join("\n");
}
