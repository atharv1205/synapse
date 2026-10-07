import type { FileNode, FunctionNode, RepoGraph } from "@synapse/core";

/**
 * Local copies of core's declaration lookup helpers.
 *
 * Copied on purpose instead of imported from `@synapse/core`. That package is Node-only
 * (tree-sitter's native bindings, simple-git, `node:child_process`), so importing any
 * value from it drags all of that into the browser bundle and the app crashes on load
 * with `promisify is not a function`. Only `import type` is safe across this line, since
 * types disappear at build time.
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
