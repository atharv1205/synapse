# Synapse

Analyses a codebase — from a GitHub URL or a local folder — and produces a dependency
graph of its files and functions, scored by how important each one is.

**Status: Phases 0-5b complete.**

## Quick start

```bash
npm install
npm run build    # turbo run build: every package in dependency order, cached locally
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

Or explore it in 3D:

```bash
npm run build
node packages/cli/dist/src/index.js serve .
```

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | The analysis engine: ingestion, parsing, graph building, scoring, LLM providers |
| `packages/cli` | The `analyze` command |
| `packages/server` | Fastify API wrapping the core functions |
| `packages/web` | React + react-three-fiber 3D viewer and Q&A UI |

## CLI

Three commands: `analyze` builds the graph, `index` builds the embedding index, and
`ask` answers questions over it. `ask` builds the index itself if one is missing, so
`index` is only needed to pre-warm.

```
synapse analyze <path-or-github-url> [options]

  --out <dir>            Where to write graph.json (default: <target>/.synapse)
  --depth <n>            Clone depth when given a URL (default: 200)
  --token <token>        Credential for a private repository (or GITHUB_TOKEN)
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

synapse serve [path] [options]
  --port <n>             Port to listen on (default: 4317)
  --host <addr>          Address to bind (default: 127.0.0.1)
  --no-open              Do not open a browser window

Shared by all three:
  --out <dir>            Where .synapse artefacts live
  --model <name>         Chat model (default: qwen2.5:14b-instruct)
  --provider <name>      ollama | anthropic (default: ollama)
  --model <name>         Chat model (provider-specific default)
  --embed-model <name>   Embedding model (default: nomic-embed-text)
  --ollama-url <url>     Ollama base URL (default: http://localhost:11434)
```

A URL is cloned shallowly into a temp directory and removed when the run finishes.
A local path is read in place and never modified.

## How it works

**Ingestion.** Walks the tree respecting `.gitignore` at every level, including nested
ignore files and negation patterns. `node_modules`, `.git`, virtualenvs and build output
are skipped unconditionally.

**Parsing.** tree-sitter parses JavaScript, TypeScript, TSX and Python, through its
callback input rather than by handing it a string. The Node binding rejects a string of
32,768 characters or more with a bare "Invalid argument", which silently cost every file
above 32KB — 515 of 18,851 on home-assistant/core, weighted toward the largest and
most-depended-on files, so the gap quietly skewed every importance score. The callback
form has no such limit, measures no slower, and produces an identical tree, so it is
used for every file rather than only large ones.

A file that still cannot be read or parsed is recorded in `parseFailures` and counted in
`stats.parseFailures` instead of being dropped in silence, and the CLI reports it
loudly. It should always be zero. Per file it
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

## The graph's shape

`functionNodes` is the single source of truth for declarations; `nodes[].functions`
holds ids into it. Resolve them with the exported `functionIndex()` and `functionsOf()`
helpers — build the index once per graph rather than scanning per file.

They used to be full objects in both places, which serialised every declaration twice:
**31.6MB of pure duplication** on an 18,851-file repo. `version` is `2` for this shape;
a `version: 1` file has the old duplicated form and should be regenerated.

## Providers

Summaries and answers can come from the local Ollama model or from the Anthropic API.
`--provider anthropic` switches the backend on `analyze`, `ask` and `serve`; the default
is `ollama` and nothing about the local path changes.

Both clients implement one `LlmProvider` interface, and **the prompts are identical
either way** — the summarisation prompt, its JSON schema, and the retrieval context
block are built by the same code and only the transport differs. There is a test that
runs the same summarisation through both providers and asserts the prompts match byte
for byte.

**Embeddings are always Ollama.** The Anthropic API has no embeddings endpoint, so
`ask` and `index` keep embedding locally even under `--provider anthropic`, and Ollama
has to be running for them. That is stated rather than worked around: the Anthropic
client's `embed()` throws instead of substituting another model — vectors from two
models are not comparable, and quietly mixing them would corrupt an index in a way that
is very hard to notice — and when the two halves differ, an Ollama failure is reported
with the reason Ollama is still involved:

```
Could not reach Ollama at http://localhost:59999 (fetch failed).
  Start it with:  ollama serve

  Answers come from anthropic (claude-opus-5), but embeddings have no anthropic
  endpoint, so retrieval still uses Ollama (nomic-embed-text). Ollama must be running.
```

The API key is read from `ANTHROPIC_API_KEY` and nowhere else — never a flag, never a
file — so it cannot land in shell history or a commit. An unset key fails preflight with
the command to fix it, exactly like a missing Ollama model does.

## Private repositories

`analyze` and `serve` accept a credential for cloning a private repo, from `--token` or
the `GITHUB_TOKEN` environment variable. The environment variable is preferred and the
help says so: a flag lands in shell history and in the process's own argv.

The token reaches git through the child process environment and is read there by an
inline credential helper. Three exposures are avoided deliberately:

- **argv** — the token is never an argument, so it cannot be read from `ps` by another
  user on the machine, and it is never embedded in the URL.
- **the clone's git config** — because the URL carries no credential, git has nothing to
  persist into `.git/config`.
- **the system keychain** — an empty `credential.helper` entry is injected first, which
  resets the helpers git would otherwise inherit, so a keychain cannot answer instead.

Any `GIT_CONFIG_*` entries already exported are preserved; Synapse's own are appended
after them rather than overwriting the count.

This one command is run through `execFile` rather than simple-git, because simple-git's
argv guard rejects credential-helper and `GIT_CONFIG_*` injection outright — which is
precisely the mechanism that keeps the token out of argv. simple-git still runs the
churn queries.

Everything user-visible is redacted first. A credential pasted into the URL is stripped
before the URL is logged, put in an error, or written to `graph.json`, and git's own
output is scrubbed of the token before it is shown. A failed clone explains what to do
rather than repeating git's raw text:

```
Could not clone https://github.com/anthropics/private-repo.
  If it is private, Synapse needs a token:
    export GITHUB_TOKEN=ghp_...   (preferred — keeps it out of shell history)
    or pass --token <token>
  If it is public, check the URL is spelled correctly.
  Git said: remote: Repository not found. fatal: repository '…' not found
```

GitHub answers an unauthenticated request for a private repo with "not found" — the same
thing it says for a typo — so the message covers both rather than claiming to know which.

## The UI

`synapse serve` starts listening immediately, then runs an analysis in the background if
there is no graph yet, serving a Fastify API and the built React app. It listens first on
purpose: summarising a repo takes minutes on a local model, and blocking the listen until
it finished meant the browser opened on a dead port. `/api/status` reports analysis
progress so the UI shows a live loading state and swaps to the graph when it lands, with
no reload. The server is deliberately thin — four routes, each of which reads a
file or calls one core function and serialises the result:

| Route | What it does |
| --- | --- |
| `GET /api/graph` | Returns `graph.json` |
| `POST /api/ask` | Calls `ask()`, returns the answer and its sources |
| `POST /api/index` | Calls `buildIndex()`, returns the report |
| `GET /api/status` | Reports Ollama, model, graph and index availability |

No scoring, chunking, retrieval or remediation logic lives in the server. `/api/status` is
just core's preflight output, so the remediation the browser shows is the same text the
CLI prints rather than a second set of wordings to keep in step. When Ollama is down the
graph still renders and stays fully explorable; only questions are disabled.

**Framing.** The camera frames against the 90th percentile of node distance from the
origin, not the maximum, and its far plane is derived from the scene's true extent
rather than hardcoded. On an 18,851-node graph the maximum was an outlier statistic —
25,282 against a median of 1,924 — which put the camera 40,451 units out, past a
hardcoded far plane of 20,000, and clipped every node in the scene. Node radii scale
with that framing radius too, so a node is about the same size on screen whatever the
graph's size; fixed world-unit radii rendered a typical node at 7px on a 26-file repo
and 0.4px on an 18,851-file one.

**Rendering.** Every node is one instance of a single `InstancedMesh` and every edge is one
segment of a single `LineSegments` buffer, so the whole graph is two draw calls whatever
its size. That matters more than node count: a few thousand individual meshes would each
cost a draw call and tank the framerate long before the data became the problem. The
importance slider therefore fades and shrinks nodes rather than unmounting them, which
keeps every file clickable and keeps Q&A sources linkable even when dimmed. Above ~300
files the view opens pre-set so it starts on the important files.

The slider works in **rank percentile**, not raw importance. PageRank is heavily
right-skewed — on the 18,851-node graph the top node scored 1.0000 and the 300th scored
0.0009 — so a linear 0-1 importance slider put every useful value inside its first step,
leaving about 0.09% of the track usable. Percentile is scale-free: half the track always
means half the files, whatever the distribution underneath.

Nodes are sized and coloured by the importance already in `graph.json` — nothing is
recomputed client-side. Edge direction is shown by a per-vertex colour gradient, dim at
the importer and bright at the imported file; arrowheads at this density would be noise.

The force layout runs to completion before the first frame rather than animating.
`d3-force-3d` runs on the main thread, so animating it on a few thousand nodes janks
badly, and a settling graph is harder to read than a settled one.

Clicking a node opens its path, summary, metrics and top functions, with a button that
pre-fills a question about it. The Q&A panel is always available; clicking a cited source
selects and flies the camera to that node.

## Output

Written to `.synapse/graph.json`:

```jsonc
{
  "version": 2,
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
      // ids into functionNodes, which holds the declarations themselves
      "functions": [ "src/hub.ts#sharedHelper" ]
    }
  ],
  "edges": [ { "from": "src/app.ts", "to": "src/hub.ts", "type": "import", "weight": 1 } ],
  "functionNodes": [ { "id": "src/hub.ts#sharedHelper", "file": "src/hub.ts",
                       "name": "sharedHelper", "kind": "function", "exported": true,
                       "startLine": 1, "endLine": 3, "importance": 1,
                       "summary": "Doubles the value it is given." } ],
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

- Large repositories work but are not fast: on home-assistant/core (18,851 Python files,
  117.7MB of source) parsing takes ~42s and peaks around 1.1GB RSS, churn adds ~2.5
  minutes, and building the embedding index takes ~10 minutes.
- The 3D view still does not read well at ~19,000 nodes even with nothing clipped. The
  layout is the limit rather than the renderer: it runs 150 synchronous ticks on the main
  thread (~39s, during which the tab is frozen), the node cloud settles about 1,284 units
  off the origin the camera looks at, and positions are still dominated by the initial
  seeding rather than by graph structure. Those are layout problems, not framing ones.
- `git log --follow` only accepts one path at a time, so churn is one git process per file.
  Bounded to 16 concurrent, but it is the slowest step by a wide margin on large repos.
- Call-graph resolution is name-based, not scope-aware. Two same-named functions in one
  file collapse to the first; dynamic dispatch and re-exported names are not traced.
- Only JS/TS/TSX and Python are parsed. Other files are ignored entirely.
- The UI bundles three.js, so the client build is around 1MB (275KB gzipped). That is
  fine over localhost and has not been optimised further.
- `--provider anthropic` sends your source code to the Anthropic API. The local path
  remains the default precisely because nothing has to leave the machine.
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

## License

MIT — see [LICENSE](LICENSE).
