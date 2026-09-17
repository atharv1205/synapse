/** Languages we can currently parse. */
export type Language = "javascript" | "typescript" | "tsx" | "python";

/** A source file discovered during ingestion, before parsing. */
export interface SourceFile {
  /** Path relative to the repo root, always POSIX-separated. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  language: Language;
  sizeBytes: number;
}

/** A function, method, or class declaration found inside a file. */
export interface FunctionSymbol {
  /** Stable id: `<file path>#<qualified name>`. */
  id: string;
  name: string;
  /** Dotted path for nested declarations, e.g. `MyClass.render`. */
  qualifiedName: string;
  kind: "function" | "method" | "class";
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Centrality-derived score within the function-level graph, 0..1. */
  importance: number;
}

/** A file-level node in the dependency graph. */
export interface FileNode {
  /** Stable id; identical to `path`. */
  id: string;
  path: string;
  type: "file";
  language: Language;
  /** Combined centrality + churn score, normalised to 0..1. */
  importance: number;
  metrics: FileMetrics;
  functions: FunctionSymbol[];
}

export interface FileMetrics {
  /** Lines of code (raw line count). */
  loc: number;
  /** Number of commits that touched this file. */
  churn: number;
  /** Files this file imports. */
  outDegree: number;
  /** Files that import this file. */
  inDegree: number;
  /** Normalised graph-centrality component of `importance`, 0..1. */
  centrality: number;
  /** Normalised churn component of `importance`, 0..1. */
  churnScore: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "import" | "call";
  /** How many times this relationship was observed. */
  weight: number;
}

/** A node in the finer-grained function-level graph. */
export interface FunctionNode {
  id: string;
  /** Owning file's path. */
  file: string;
  name: string;
  qualifiedName: string;
  kind: FunctionSymbol["kind"];
  type: "function";
  importance: number;
  startLine: number;
  endLine: number;
}

export interface RepoGraph {
  version: 1;
  /** Where the analysed source lived. For clones, the original URL. */
  source: string;
  generatedAt: string;
  stats: GraphStats;
  nodes: FileNode[];
  edges: GraphEdge[];
  functionNodes: FunctionNode[];
  functionEdges: GraphEdge[];
}

export interface GraphStats {
  fileCount: number;
  edgeCount: number;
  functionCount: number;
  functionEdgeCount: number;
  /** Imports that pointed outside the repo (node_modules, stdlib, unresolved). */
  externalImports: number;
  byLanguage: Record<string, number>;
  /** True when git history was available and churn was measured. */
  churnAvailable: boolean;
}
