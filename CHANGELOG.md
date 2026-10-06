# Changelog

All notable changes to `synapse-map` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

The first public release.

### Added

- `synapse analyze`, `index`, `ask` and `serve`, installed as both `synapse` and
  `synapse-map`, for a local folder or a GitHub URL.
- Parsing of JavaScript, TypeScript, TSX, Python, Java and Go with tree-sitter, with
  imports matched only to files that exist: NodeNext `.js` specifiers, index files,
  Python relative imports, workspace packages, Java source roots and Go modules.
- File ranking by PageRank over the import graph blended with git churn, and a
  function-level call graph.
- Summaries of the most important files and question answering with cited sources,
  from a local model through Ollama, or from Gemini or Claude.
- A 3D explorer: an importance slider, file details, labels, an Ask panel, a folder view
  that large repositories open in, and a start page for analysing another repository.
- Repository details from GitHub, and private repositories through a token that is never
  stored.
- A local server bound to `127.0.0.1` with a host guard against DNS rebinding and a
  strict Content-Security-Policy.

[Unreleased]: https://github.com/atharv1205/synapse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/atharv1205/synapse/releases/tag/v0.1.0
