import graphologyModule from "graphology";
import pagerankModule from "graphology-metrics/centrality/pagerank.js";
import type { AbstractGraph as Graph } from "graphology-types";
import type { ParsedFile } from "../parse/extract.js";
import type {
  FileNode,
  ParseFailure,
  FunctionNode,
  FunctionSymbol,
  GraphEdge,
  GraphStats,
  SourceFile,
} from "../types.js";
import type { ImportResolver } from "./resolve.js";
import { DEFAULT_WEIGHTS, normalize, normalizeChurn, round, type ScoreWeights } from "./score.js";

// graphology and graphology-metrics ship CJS with a .d.ts that claims an ES default
// export. Under NodeNext the import comes back as the module object, not the
// class/function it really is at runtime, so we fix up the types once here.
const DirectedGraph = graphologyModule as unknown as new (options?: {
  type?: "directed" | "undirected" | "mixed";
  multi?: boolean;
  allowSelfLoops?: boolean;
}) => Graph;

const pagerank = pagerankModule as unknown as (
  graph: Graph,
  options?: { getEdgeWeight?: string | null; alpha?: number },
) => Record<string, number>;

export interface BuildInput {
  files: SourceFile[];
  parsed: Map<string, ParsedFile>;
  resolver: ImportResolver;
  churn: Map<string, number>;
  churnAvailable: boolean;
  weights?: ScoreWeights;
  /** Files that never made it into `parsed`. We pass them through to the stats. */
  parseFailures?: ParseFailure[];
}

export interface BuildResult {
  nodes: FileNode[];
  edges: GraphEdge[];
  functionNodes: FunctionNode[];
  functionEdges: GraphEdge[];
  stats: GraphStats;
}

/** Merge repeated links between the same two nodes into one weighted edge. */
function collapse(pairs: Array<{ from: string; to: string }>, type: GraphEdge["type"]): GraphEdge[] {
  const weights = new Map<string, Map<string, number>>();
  for (const { from, to } of pairs) {
    let targets = weights.get(from);
    if (!targets) {
      targets = new Map<string, number>();
      weights.set(from, targets);
    }
    targets.set(to, (targets.get(to) ?? 0) + 1);
  }

  const edges: GraphEdge[] = [];
  for (const [from, targets] of weights) {
    for (const [to, weight] of targets) edges.push({ from, to, type, weight });
  }
  return edges;
}

/**
 * PageRank with edges going importer -> imported, so importance flows to the stuff
 * everything depends on. Isolated nodes still get the baseline rank, which is fine, they
 * just aren't central.
 */
function pagerankScores(nodeIds: string[], edges: GraphEdge[]): Map<string, number> {
  const graph = new DirectedGraph({ type: "directed", multi: false, allowSelfLoops: false });
  for (const id of nodeIds) graph.mergeNode(id);
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) continue;
    graph.addDirectedEdge(edge.from, edge.to, { weight: edge.weight });
  }

  const scores = new Map<string, number>();
  if (graph.order === 0) return scores;

  const ranks = pagerank(graph, { getEdgeWeight: "weight" });
  for (const [node, rank] of Object.entries(ranks)) scores.set(node, rank);
  return scores;
}

export function buildGraph(input: BuildInput): BuildResult {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const filePaths = input.files.map((f) => f.path);

  // --- Declarations -----------------------------------------------------------
  const symbolsByFile = new Map<string, FunctionSymbol[]>();
  /** file -> name -> symbol id. Used to resolve package imports and calls. */
  const symbolIndex = new Map<string, Map<string, string>>();

  for (const file of input.files) {
    const parsed = input.parsed.get(file.path);
    const symbols = parsed?.symbols ?? [];
    symbolsByFile.set(file.path, symbols);

    const index = new Map<string, string>();
    for (const symbol of symbols) {
      // If a name shows up twice (two `render` methods, say), keep the first one.
      if (!index.has(symbol.name)) index.set(symbol.name, symbol.id);
      index.set(symbol.qualifiedName, symbol.id);
    }
    symbolIndex.set(file.path, index);
  }

  // --- File-level edges -----------------------------------------------------
  const importPairs: Array<{ from: string; to: string }> = [];
  let externalImports = 0;

  /** Per file: local binding name -> the repo file it came from. */
  const bindingOrigins = new Map<string, Map<string, string>>();

  for (const file of input.files) {
    const parsed = input.parsed.get(file.path);
    if (!parsed) continue;

    const bindings = new Map<string, string>();
    bindingOrigins.set(file.path, bindings);

    for (const ref of parsed.imports) {
      let targets = input.resolver.resolveAll(file.path, file.language, ref);
      if (targets.length === 0) {
        if (!ref.implicit) externalImports++;
        continue;
      }

      if (ref.uses) {
        // Package import: keep only the package files that declare something the importer
        // uses, and remember which file each name came from so calls through it resolve.
        const declaring = targets.filter((target) => {
          const index = symbolIndex.get(target);
          let hit = false;
          for (const name of ref.uses!) {
            if (index?.has(name)) {
              bindings.set(name, target);
              hit = true;
            }
          }
          return hit;
        });
        // Implicit deps and Java wildcards only exist through what's actually used. A Go
        // import that matches nothing (probably constants or vars, which we don't track)
        // still counts, because Go won't compile unused imports anyway.
        const keepAll = declaring.length === 0 && ref.kind === "go" && !ref.implicit;
        targets = keepAll ? targets : declaring;
      }

      for (const target of targets) importPairs.push({ from: file.path, to: target });
      const first = targets[0];
      if (first) for (const name of ref.names) bindings.set(name.local, first);
    }
  }

  const edges = collapse(importPairs, "import");

  // --- File importance ------------------------------------------------------
  const centrality = normalize(pagerankScores(filePaths, edges));
  const churnScore = normalizeChurn(new Map(filePaths.map((p) => [p, input.churn.get(p) ?? 0])));

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // No git history means churn tells us nothing, so give centrality all the weight.
  const churnWeight = input.churnAvailable ? weights.churn : 0;
  const totalWeight = weights.centrality + churnWeight;

  // --- Function-level graph -------------------------------------------------

  const callPairs: Array<{ from: string; to: string }> = [];

  for (const file of input.files) {
    const parsed = input.parsed.get(file.path);
    if (!parsed) continue;
    const localIndex = symbolIndex.get(file.path);
    const bindings = bindingOrigins.get(file.path);

    for (const call of parsed.calls) {
      if (!call.enclosing) continue; // module-level calls have no caller function

      // Look in the same file first, then in whatever the name was imported from.
      let target = localIndex?.get(call.callee);
      if (!target) {
        const origin = bindings?.get(call.callee);
        if (origin) target = symbolIndex.get(origin)?.get(call.callee);
      }

      if (target && target !== call.enclosing) {
        callPairs.push({ from: call.enclosing, to: target });
      }
    }
  }

  const functionEdges = collapse(callPairs, "call");

  const allSymbols = [...symbolsByFile.values()].flat();
  const functionCentrality = normalize(
    pagerankScores(
      allSymbols.map((s) => s.id),
      functionEdges,
    ),
  );

  // functionNodes is the real list; file nodes just point into it by id.
  const functionNodes: FunctionNode[] = [];
  const functionIdsByFile = new Map<string, string[]>();

  for (const file of input.files) {
    const ids: string[] = [];
    for (const symbol of symbolsByFile.get(file.path) ?? []) {
      symbol.importance = round(functionCentrality.get(symbol.id) ?? 0);
      ids.push(symbol.id);
      functionNodes.push({
        id: symbol.id,
        file: file.path,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        type: "function",
        importance: symbol.importance,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        exported: symbol.exported,
      });
    }
    functionIdsByFile.set(file.path, ids);
  }

  // --- Assemble file nodes --------------------------------------------------
  const byLanguage: Record<string, number> = {};
  const nodes: FileNode[] = input.files.map((file) => {
    byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;

    const c = centrality.get(file.path) ?? 0;
    const k = churnScore.get(file.path) ?? 0;
    const importance = (weights.centrality * c + churnWeight * k) / totalWeight;

    return {
      id: file.path,
      path: file.path,
      type: "file",
      language: file.language,
      importance: round(importance),
      metrics: {
        loc: input.parsed.get(file.path)?.loc ?? 0,
        churn: input.churn.get(file.path) ?? 0,
        outDegree: outDegree.get(file.path) ?? 0,
        inDegree: inDegree.get(file.path) ?? 0,
        centrality: round(c),
        churnScore: round(k),
      },
      functions: functionIdsByFile.get(file.path) ?? [],
    };
  });

  nodes.sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path));
  functionNodes.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    functionNodes,
    functionEdges,
    stats: {
      fileCount: nodes.length,
      edgeCount: edges.length,
      functionCount: functionNodes.length,
      functionEdgeCount: functionEdges.length,
      externalImports,
      parseFailures: input.parseFailures?.length ?? 0,
      byLanguage,
      churnAvailable: input.churnAvailable,
    },
  };
}
