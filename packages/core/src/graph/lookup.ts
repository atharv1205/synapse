import type { FileNode, FunctionNode, RepoGraph } from "../types.js";

/**
 * Indexes the canonical declaration list by id.
 *
 * `FileNode.functions` stores ids rather than copies, so anything that needs the
 * declarations themselves resolves them through here. Build the index once and reuse
 * it; resolving each file by scanning the list would be quadratic.
 */
export function functionIndex(graph: RepoGraph): Map<string, FunctionNode> {
  return new Map(graph.functionNodes.map((fn) => [fn.id, fn]));
}

/** Resolves one file's declarations, skipping any id with no matching node. */
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

/** Convenience for one-off lookups where building an index would be overkill. */
export function resolveFunctions(graph: RepoGraph, node: FileNode): FunctionNode[] {
  return functionsOf(node, functionIndex(graph));
}
