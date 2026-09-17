# repograph

Analyses a codebase — from a GitHub URL or a local folder — and produces a dependency
graph of its files and functions, scored by how important each one is.

**Status: Phase 0 and Phase 1 complete.** The LLM summaries, RAG Q&A and 3D viewer are
not built yet.

## Quick start

```bash
npm install
npm run build
node packages/cli/dist/src/index.js analyze .
```

Or point it at a repo:

```bash
node packages/cli/dist/src/index.js analyze https://github.com/pallets/itsdangerous
```

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | The analysis engine: ingestion, parsing, graph building, scoring |
| `packages/cli` | The `analyze` command |
| `packages/web` | Placeholder for the 3D viewer (Phase 3) |

## CLI

```
repograph analyze <path-or-github-url> [options]

  --out <dir>       Where to write graph.json (default: <target>/.repograph)
  --depth <n>       Clone depth when given a URL (default: 200)
  --top <n>         How many files to list in the summary (default: 10)
  --skip-churn      Skip the git history pass
  --json            Print the graph to stdout instead of writing a file
```

A URL is cloned shallowly into a temp directory and removed when the run finishes.
A local path is read in place and never modified.

## How it works

**Ingestion.** Walks the tree respecting `.gitignore` at every level, including nested
ignore files and negation patterns. `node_modules`, `.git`, virtualenvs and build output
are skipped unconditionally.

**Parsing.** tree-sitter parses JavaScript, TypeScript, TSX and Python. Per file it
extracts import statements (ESM, `require`, dynamic `import()`, and Python's `import` /
`from ... import` including relative forms), function/class/method declarations, and call
sites attributed to the function that encloses them.

**Resolution.** Import specifiers are resolved against the files actually present in the
repo. This handles the awkward cases: TypeScript's NodeNext convention of writing
`./foo.js` to mean `./foo.ts`, extensionless directory imports resolving to `index.*`,
Python relative imports with multiple leading dots, Python absolute imports under a `src/`
layout, and bare specifiers that point at sibling workspace packages in a monorepo.
Anything left over is counted as an external dependency, not invented as a node.

**Scoring.** Two signals, blended 70/30:

- *Centrality* — PageRank over the file graph, with edges pointing importer → imported so
  that importance flows toward the modules everything depends on.
- *Churn* — commits touching each file, via `git log --follow`, so a renamed file keeps the
  history it earned under its old name. Counts are log-compressed before normalising,
  because commit counts are heavy-tailed and one 400-commit config file would otherwise
  flatten everything else.

When the target has no git history, churn is dropped and centrality takes the full weight.

The function-level graph is built the same way: nodes are declarations, edges are resolved
calls, and PageRank over it scores each function. Call resolution is a heuristic — a call
is matched against declarations in the same file first, then against the file a name was
imported from. Calls it cannot resolve are dropped rather than guessed at.

## Output

Written to `.repograph/graph.json`:

```jsonc
{
  "version": 1,
  "source": "https://github.com/owner/repo",
  "generatedAt": "2026-09-17T…",
  "stats": { "fileCount": 12, "edgeCount": 28, "externalImports": 21, … },
  "nodes": [
    {
      "id": "src/hub.ts",
      "path": "src/hub.ts",
      "type": "file",
      "language": "typescript",
      "importance": 0.85,
      "metrics": { "loc": 102, "churn": 3, "inDegree": 7, "outDegree": 0,
                   "centrality": 1, "churnScore": 0.5 },
      "functions": [ { "id": "src/hub.ts#sharedHelper", "name": "sharedHelper",
                       "kind": "function", "startLine": 1, "endLine": 3,
                       "exported": true, "importance": 1 } ]
    }
  ],
  "edges": [ { "from": "src/app.ts", "to": "src/hub.ts", "type": "import", "weight": 1 } ],
  "functionNodes": [ … ],
  "functionEdges": [ { "from": "src/util.ts#double", "to": "src/hub.ts#sharedHelper",
                       "type": "call", "weight": 1 } ]
}
```

## Tests

```bash
npm test
```

Builds a real git repo in a temp directory with a known dependency shape and a known
commit distribution, then runs the actual walker, parser and `git log` against it — no
mocks. Asserts that the hub file outranks the orphan, that churn breaks ties between files
of equal centrality, and that the awkward resolution cases above all land.

## Known limits

- `git log --follow` only accepts one path at a time, so churn is one git process per file.
  Bounded to 16 concurrent, but it is the slowest step by a wide margin on large repos.
- Call-graph resolution is name-based, not scope-aware. Two same-named functions in one
  file collapse to the first; dynamic dispatch and re-exported names are not traced.
- Only JS/TS/TSX and Python are parsed. Other files are ignored entirely.
