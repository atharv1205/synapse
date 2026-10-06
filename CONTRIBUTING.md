# Contributing to Synapse

Thanks for your interest in Synapse. Bug reports, ideas, documentation fixes and code are
all welcome. This guide covers how to get set up and what a good pull request looks like.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug.** Open an issue with the command you ran, what you expected, what
  happened, and your OS and Node version. If the ranking looks wrong on a public
  repository, link it: that is the most useful report there is.
- **Suggest a feature.** Open an issue describing the problem first, before the solution,
  so we can agree on the approach before anyone writes code.
- **Fix something.** Issues labelled `good first issue` are a good place to start. For
  anything larger, comment on the issue first so work is not duplicated.

Security problems should not go in a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

You need Node.js 20 or later (22 recommended) and git. Ollama is only needed to try
summaries and questions by hand; the test suite never starts a model.

```bash
git clone https://github.com/atharv1205/synapse.git
cd synapse
npm install
npm run build
npm test
```

Run your local build against any project:

```bash
node packages/cli/dist/src/index.js serve /path/to/a/project --skip-summarize
```

## How the code is organised

| Package | What it holds |
| --- | --- |
| `packages/core` | Ingestion, parsing, import resolution, the graph and scoring, LLM providers, retrieval |
| `packages/server` | The Fastify API, security headers and host guard |
| `packages/cli` | The `synapse` command |
| `packages/web` | The React and three.js explorer and the start page |

Builds go through Turborepo, so `npm run build` and `npm test` only redo what changed.
To work on the UI with hot reload, see the Development section of the
[README](README.md#development).

## Making a change

1. Fork the repository and create a branch from the default branch.
2. Make your change, with tests. Every package uses Node's built-in test runner
   (`node:test`); look at the existing tests next to the code you are changing.
3. Run the checks CI runs:

   ```bash
   npm test               # build and test every package
   npm run release:pack   # assemble the npm package
   npm run smoke          # install that package in a scratch folder and run it
   ```

4. Open a pull request and fill in the template.

### Guidelines

- **Match the surrounding code.** Naming, comment density and style should read like
  the file you are editing. Comments explain why something is done, not what the next
  line does.
- **Keep the dependency list short.** Synapse prefers Node's built-ins where they are
  good enough. Please open an issue before adding a new dependency.
- **Never invent graph nodes.** An import that cannot be matched to a real file is
  counted as external, not guessed at.
- **Keep it local by default.** Nothing should send code to a network service unless
  the user chose a cloud provider. API keys are read from environment variables only.
- **Update the docs.** If behaviour or a flag changes, update the README in the same
  pull request.

### Commit messages

The history uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(parse): extract Kotlin imports
fix(web): keep folder labels from overlapping
docs: explain the --summarize-top flag
```

Keep the subject under about 72 characters, and use the body to explain why.

## Adding a language

Synapse reads JavaScript, TypeScript, Python, Java and Go. A new language touches these
places, and the Java and Go support is a good model to follow:

1. **Grammar.** Add the tree-sitter grammar package to `packages/core/package.json`,
   using a version compatible with the `tree-sitter` already there, and register it in
   `packages/core/src/parse/parser.ts`.
2. **Language and file types.** Add it to `Language` in `packages/core/src/types.ts` and
   its extensions to `packages/core/src/ingest/walk.ts`.
3. **Extraction.** Add a visitor in `packages/core/src/parse/extract.ts` that records
   imports, declarations and call sites.
4. **Resolution.** Teach `packages/core/src/graph/resolve.ts` to map the language's
   imports to files in the repository.
5. **Display.** Add its name in `packages/web/src/components/NodeDetails.tsx`.
6. **Tests.** Add parser tests and a small end-to-end project, as in
   `packages/core/test/languages.test.ts`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), the same as the rest of the project.
