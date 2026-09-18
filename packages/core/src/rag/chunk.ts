import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { signatureOf } from "../summarize/prompt.js";
import type { FileNode, FunctionNode, RepoGraph } from "../types.js";
import { functionIndex, functionsOf } from "../graph/lookup.js";

/** One retrievable unit: the text that gets embedded, plus what it points back at. */
export interface Chunk {
  /** Stable id: `file:<path>` or `fn:<function id>`. */
  id: string;
  kind: "file" | "function";
  /** Owning file, for citing sources. */
  path: string;
  /** Qualified function name, for function chunks. */
  ref?: string;
  /** Line the chunk's subject starts on, for citing sources. */
  startLine?: number;
  /** File importance, used to break ties between equally similar chunks. */
  importance: number;
  /** The text that is embedded and later shown to the answering model. */
  text: string;
  /** SHA-256 of `text`; the cache key, mirroring how summaries are keyed. */
  hash: string;
}

export function chunkHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function finish(chunk: Omit<Chunk, "hash">): Chunk {
  return { ...chunk, hash: chunkHash(chunk.text) };
}

/**
 * A file chunk: what the file is, what it declares, and why the graph thinks it
 * matters. This is the coarse level, for questions like "where does X live".
 */
function fileChunk(node: FileNode, declarations: FunctionNode[]): Chunk {
  const { metrics } = node;
  const lines: string[] = [
    `File: ${node.path}`,
    `Language: ${node.language}`,
  ];

  if (node.summary) lines.push("", `Summary: ${node.summary}`);

  lines.push(
    "",
    `Graph: importance ${node.importance.toFixed(3)}, imported by ${metrics.inDegree} file(s), ` +
      `imports ${metrics.outDegree} file(s), ${metrics.churn} commit(s), ${metrics.loc} lines.`,
  );

  if (declarations.length > 0) {
    lines.push("", "Declares:");
    for (const fn of declarations) {
      const marker = fn.exported ? " (exported)" : "";
      lines.push(`- ${fn.kind} ${fn.qualifiedName}${marker}`);
    }
  } else {
    lines.push("", "Declares no functions or classes.");
  }

  return finish({
    id: `file:${node.path}`,
    kind: "file",
    path: node.path,
    importance: node.importance,
    text: lines.join("\n"),
  });
}

/**
 * A function chunk: one per individually-summarised function, carrying its signature
 * and what it calls. This is the fine level, for questions about specific behaviour.
 */
function functionChunk(
  node: FileNode,
  fn: FunctionNode,
  signature: string,
  calls: string[],
): Chunk {
  const lines: string[] = [
    `Function: ${fn.qualifiedName}`,
    `In file: ${node.path} (line ${fn.startLine})`,
    `Kind: ${fn.kind}${fn.exported ? ", exported" : ""}`,
    `Signature: ${signature}`,
  ];

  if (fn.summary) lines.push("", `Summary: ${fn.summary}`);

  if (calls.length > 0) {
    lines.push("", `Calls: ${calls.join(", ")}`);
  } else {
    lines.push("", "Calls no other functions that could be resolved in this repo.");
  }

  return finish({
    id: `fn:${fn.id}`,
    kind: "function",
    path: node.path,
    ref: fn.qualifiedName,
    startLine: fn.startLine,
    importance: node.importance,
    text: lines.join("\n"),
  });
}

/**
 * Builds the chunk set for a graph: one chunk per file, plus one per function that
 * carries its own summary.
 *
 * `root` is used to recover real signatures from source. When a file cannot be read —
 * the repo moved, or this is a graph.json from a clone that no longer exists — the
 * signature falls back to what the graph already knows, so indexing still works.
 */
export async function buildChunks(graph: RepoGraph, root?: string): Promise<Chunk[]> {
  const outgoing = new Map<string, string[]>();
  const nameById = new Map(graph.functionNodes.map((fn) => [fn.id, fn.qualifiedName]));

  for (const edge of graph.functionEdges) {
    const target = nameById.get(edge.to);
    if (!target) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(target);
    else outgoing.set(edge.from, [target]);
  }

  const chunks: Chunk[] = [];
  const declarations = functionIndex(graph);

  for (const node of graph.nodes) {
    const own = functionsOf(node, declarations);
    chunks.push(fileChunk(node, own));

    const summarised = own.filter((fn) => fn.summary);
    if (summarised.length === 0) continue;

    let lines: string[] | undefined;
    if (root) {
      try {
        lines = (await readFile(path.join(root, node.path), "utf8")).split("\n");
      } catch {
        // Unreadable source just means no real signature for this file.
      }
    }

    for (const fn of summarised) {
      const signature = lines
        ? signatureOf(fn, lines)
        : `${fn.kind} ${fn.qualifiedName}`;
      chunks.push(functionChunk(node, fn, signature, outgoing.get(fn.id) ?? []));
    }
  }

  return chunks;
}
