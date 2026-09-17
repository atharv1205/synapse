# Synapse

Analyses a codebase — from a GitHub URL or a local folder — and produces a dependency
graph of its files and functions, scored by how important each one is.

**Status: Phases 0-3 complete.** The 3D viewer is not built yet.

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

Then ask it things:

```bash
ollama pull nomic-embed-text
node packages/cli/dist/src/index.js ask "what does the import resolver handle?" --show-sources
```

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | The analysis engine: ingestion, parsing, graph building, scoring |
| `packages/cli` | The `analyze` command |
| `packages/web` | Placeholder for the 3D viewer (Phase 3) |

## CLI

Three commands: `analyze` builds the graph, `index` builds the embedding index, and
`ask` answers questions over it. `ask` builds the index itself if one is missing, so
`index` is only needed to pre-warm.

```
synapse analyze <path-or-github-url> [options]

  --out <dir>            Where to write graph.json (default: <target>/.synapse)
  --depth <n>            Clone depth when given a URL (default: 200)
  --top <n>              How many files to list in the summary (default: 10)
  --skip-churn           Skip the git history pass

  --skip-summarize       Skip LLM summarisation entirely
  --model <name>         Ollama model (default: qwen2.5:14b-instruct)
  --summarize-top <n>    How many top files to summarise (default: 50)
  --ollama-url <url>     Ollama base URL (default: http://localhost:11434)

  --json                 Print the graph to stdout instead of writing a file

synapse index [path] [options]
  --path <dir>           Repo root, for recovering function signatures (default: .)

synapse ask "<question>" [options]
  --path <dir>           Repo root (default: .)
  --top-k <n>            How many chunks to retrieve (default: 8)
  --show-sources         List the files and functions the answer drew on

Shared by all three:
  --out <dir>            Where .synapse artefacts live
  --model <name>         Chat model (default: qwen2.5:14b-instruct)
  --embed-model <name>   Embedding model (default: nomic-embed-text)
  --ollama-url <url>     Ollama base URL (default: http://localhost:11434)
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

**Summarisation.** A local model via Ollama writes a 1-3 sentence summary for each of the
top `--summarize-top` files, plus one sentence for each file's three most-called
functions. Only the top files are summarised, because this is the slow step and most of a
repo is not worth the tokens.

Each prompt carries the file's path, the graph metrics that made it significant (in/out
degree, churn, size), its declaration list with real signatures, and the first 6000
characters of source. One structured-output request per file returns the file summary and
its function summaries together. Function names the file does not actually declare are
dropped, so a hallucinated name cannot reach the graph.

Results are cached in `.synapse/summaries.json`, keyed by a SHA-256 of the file's path and
contents and tagged with the model and prompt version. A re-run only calls the model for
files that actually changed — on this repo a fully cached re-run takes under half a second.

If Ollama is not running or the model is not pulled, the run reports exactly how to fix it
and continues without summaries. It never takes down the analysis.

**Retrieval.** `ask` embeds the question locally and retrieves the most similar chunks,
then hands them to the chat model with instructions to answer only from that context and
to say so when the context falls short.

Retrieval reserves half the results for each chunk kind rather than ranking purely by
similarity. File chunks carry a summary plus a full declaration list plus metrics, so
they average about 600 characters against roughly 370 for function chunks. That breadth
makes them score moderately well against almost anything, and on a global ranking they
crowd out the shorter function chunks that hold the specific answer. Each kind gets
floor(k/2) seats; leftover seats go to the best unclaimed chunks of either kind, which
keeps it sensible when one kind is scarce or k is 1.

This is a variance reducer, not a strict improvement, and it cuts both ways. Asked how a
file's importance score is calculated, a global ranking returned eight chunks of which
only two were functions, and `pagerankScores` and `normalizeChurn` both missed the cut;
balancing promoted them and measurably improved the answer. Asked how import specifiers
resolve, a global ranking returned six function chunks to two file chunks — function
chunks genuinely deserved the space there, and balancing pulled them back to four.
`--global-rank` turns the reservation off when that trade is the wrong one.

The corpus is chunked at two granularities so retrieval can be specific: one chunk per
file (path, summary, full declaration list, graph metrics) and one chunk per
individually-summarised function (summary, real signature sliced from source, owning
file, resolved outgoing calls). Coarse chunks answer "where does X live"; fine chunks
answer questions about specific behaviour.

Chunks are keyed by a SHA-256 of their own text, the same invalidation rule summaries
use, so re-indexing only embeds what changed. Changing `--embed-model` invalidates
everything, because vectors from two models are not comparable.

**The vector store is brute-force cosine over a flat `Float32Array`, deliberately.**
Synapse indexes one chunk per file plus a few per summarised file, so even a large repo
lands in the low tens of thousands of chunks. Measured: 3ms per query at 1,000 chunks,
6ms at 5,000, 24ms at 20,000, 60ms at 50,000. LanceDB was considered and rejected — it
pulls 134 packages including the OpenAI SDK and `@huggingface/transformers`, which is a
strange thing to install into a tool whose premise is that nothing leaves your machine.
The store sits behind a `VectorStore` interface, so swapping in an ANN backend later is
a contained change.

Vectors are stored unit-length in `.synapse/embeddings.bin` with metadata in
`.synapse/embeddings.json`, so a dot product *is* the cosine similarity and no
per-comparison normalisation is needed.

## Output

Written to `.synapse/graph.json`:

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
      "summary": "Defines the shared helpers the rest of the package builds on.",
      "functions": [ { "id": "src/hub.ts#sharedHelper", "name": "sharedHelper",
                       "kind": "function", "startLine": 1, "endLine": 3,
                       "exported": true, "importance": 1,
                       "summary": "Doubles the value it is given." } ]
    }
  ],
  "edges": [ { "from": "src/app.ts", "to": "src/hub.ts", "type": "import", "weight": 1 } ],
  "functionNodes": [ … ],
  "functionEdges": [ { "from": "src/util.ts#double", "to": "src/hub.ts#sharedHelper",
                       "type": "call", "weight": 1 } ],
  "summarization": { "ran": true, "model": "qwen2.5:14b-instruct", "selected": 50,
                     "fromCache": 47, "generated": 3, "failed": 0 }
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

Summarisation is tested against a fake backend that records prompts and returns canned
responses, so the suite never starts a model or touches the network. It covers the cache
round-trip, that a changed file re-summarises while its unchanged neighbours do not, that
preflight failures degrade gracefully, and that hallucinated function names are dropped.

Retrieval is tested against a deterministic fake embedder — a bag-of-words vector over a
fixed vocabulary — so cosine ranking is exercised for real without a model. It covers
chunk construction at both granularities, the store's save/load round-trip, that an
unchanged rebuild embeds nothing, that only edited chunks are re-embedded, that changing
the embedding model invalidates the index, and that every failure mode returns
remediation rather than throwing.

## Known limits

- `git log --follow` only accepts one path at a time, so churn is one git process per file.
  Bounded to 16 concurrent, but it is the slowest step by a wide margin on large repos.
- Call-graph resolution is name-based, not scope-aware. Two same-named functions in one
  file collapse to the first; dynamic dispatch and re-exported names are not traced.
- Only JS/TS/TSX and Python are parsed. Other files are ignored entirely.
- Summaries are only as good as the local model. The prompt sends the first 6000
  characters of a file, so a summary of a very large file describes its head, not its tail.
- Retrieval searches summaries and declarations, not raw source. A question whose answer
  lives in a function body that was never summarised will not find it, and no ranking
  strategy can recover what the summaries do not say. The clearest example: the 70/30
  importance blend lives in `buildGraph`'s body and a code comment, so asking how
  importance is calculated retrieves the churn and PageRank pieces but never `buildGraph`
  itself, whose chunk ranks 9th among function chunks for that query. Raising
  `--summarize-top` widens what is answerable; surfacing this particular fact would need
  source text in the chunks, not better ranking.
- Embeddings need a model built for them. Asking a chat model to embed fails, because
  Ollama only starts embedding-capable runners for embedding models; `synapse index`
  detects this and names the fix.
