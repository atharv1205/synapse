import type { FileNode, FunctionNode, RepoGraph } from "@synapse/core";

/**
 * Local copies of core's declaration-lookup helpers.
 *
 * These are deliberately duplicated rather than imported from `@synapse/core`. That
 * package is Node-only — it pulls in tree-sitter's native bindings, simple-git and
 * `node:child_process` — so a value import from it drags all of that into the browser
 * bundle and the app dies on load with `promisify is not a function`. Only `import type`
 * is safe across this boundary, and types are erased at build time.
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
