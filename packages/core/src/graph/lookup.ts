import type { FileNode, FunctionNode, RepoGraph } from "../types.js";

/**
 * Index the declaration list by id.
 *
 * `FileNode.functions` only stores ids, so anything that needs the actual declarations
 * goes through here. Build it once and reuse it; scanning the list for every file would
 * be quadratic.
 */
export function functionIndex(graph: RepoGraph): Map<string, FunctionNode> {
  return new Map(graph.functionNodes.map((fn) => [fn.id, fn]));
}

/** One file's declarations. Ids with no matching node are skipped. */
export function functionsOf(
  node: FileNode,
  index: Map<string, FunctionNode>,
): FunctionNode[] {
  const out: FunctionNode[] = [];
  for (const id of node.functions) {
    const fn = index.get(id);
    if (fn) out.push(fn);
  }
  return out;
}

/** Shortcut for one-off lookups where building an index isn't worth it. */
export function resolveFunctions(graph: RepoGraph, node: FileNode): FunctionNode[] {
  return functionsOf(node, functionIndex(graph));
}
