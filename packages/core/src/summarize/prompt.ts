import type { FileNode, FunctionNode } from "../types.js";
import type { JsonSchema } from "../llm/types.js";

/**
 * Bump this when the prompt or schema changes enough to make old summaries stale. Cached
 * entries remember their version and get regenerated when it doesn't match.
 */
export const PROMPT_VERSION = 1;

/** How much of a file we send. Enough for context, small enough to stay quick. */
export const MAX_SOURCE_CHARS = 6_000;

/** How many functions per file get their own one-liner. */
export const TOP_FUNCTIONS_PER_FILE = 3;

/** A function picked for summarising, plus the call count that got it picked. */
export interface RankedFunction {
  symbol: FunctionNode;
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
 * Get a declaration's signature by taking the line it starts on. Cheap and right for the
 * usual one-line case; multi-line params just get cut off with an ellipsis instead of us
 * trying to rebuild them. Java declarations start at their annotations, so we skip lines
 * that are only annotations.
 */
export function signatureOf(symbol: FunctionNode, lines: string[]): string {
  let index = symbol.startLine - 1;
  while (index < symbol.endLine - 1 && /^\s*(@[\w.]+(\([^)]*\))?\s*)+$/.test(lines[index] ?? "")) index++;
  const line = lines[index]?.trim() ?? symbol.name;
  const cleaned = line.replace(/\s*\{\s*$/, "").replace(/\s*:\s*$/, "");
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117)}...`;
}

/** Keep the top of the file, where the imports and main declarations usually are. */
export function truncateSource(source: string, limit = MAX_SOURCE_CHARS): {
  text: string;
  truncated: boolean;
} {
  if (source.length <= limit) return { text: source, truncated: false };
  return { text: source.slice(0, limit), truncated: true };
}

function languageFence(language: FileNode["language"]): string {
  if (language === "python" || language === "java" || language === "go") return language;
  return "typescript";
}

/**
 * Build the prompt for one file: why it matters (graph metrics), what it declares
 * (signatures) and what it actually says (a capped chunk of source). That way the model
 * describes the file's role instead of just paraphrasing the code.
 */
export function buildFilePrompt(
  node: FileNode,
  /** The file's declarations, looked up from `functionNodes` by the caller. */
  declarations: FunctionNode[],
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

  const allSignatures = declarations.map((fn) => {
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
