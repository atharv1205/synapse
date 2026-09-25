import { lazy, Suspense, useEffect, useState } from "react";
import { api, repoNameOf, type Status } from "../api";
import { GitHubIcon } from "../components/icons";
import { Link } from "../router";
import { SITE } from "../site";
import { CommandBlock } from "./CommandBlock";
import "./landing.css";

// three.js is most of the bundle. Splitting the hero out lets the words paint first.
const HeroGraph = lazy(() => import("./HeroGraph"));

/** What this page knows about a locally running server, if there is one. */
type Served =
  | { state: "checking" }
  | { state: "absent" }
  | { state: "present"; name: string; fileCount?: number; analysing: boolean };

/**
 * The same build is served by `synapse serve` and can be hosted statically. Asking
 * /api/status tells the two apart: when a server answers, the page offers to open the
 * repository it is serving; when none does, it points at the setup steps instead.
 */
function useServed(): Served {
  const [served, setServed] = useState<Served>({ state: "checking" });

  useEffect(() => {
    let live = true;
    api
      .status()
      .then((status: Status) => {
        if (!live) return;
        setServed({
          state: "present",
          name: repoNameOf(status.root),
          fileCount: status.graph.fileCount,
          analysing: !status.graph.exists,
        });
      })
      .catch(() => live && setServed({ state: "absent" }));
    return () => {
      live = false;
    };
  }, []);

  return served;
}

const CLI = "node packages/cli/dist/src/index.js";
/** The example target every usage step points at, so the steps chain together. */
const PROJECT = "~/code/your-project";

const PIPELINE = [
  {
    name: "Parse",
    text: "tree-sitter reads JavaScript, TypeScript and Python, honouring every .gitignore, and pulls out imports, declarations and call sites.",
  },
  {
    name: "Resolve",
    text: "Imports are matched to files that actually exist: NodeNext .js specifiers, index files, Python relative imports, sibling workspace packages.",
  },
  {
    name: "Rank",
    text: "PageRank over the import graph, blended 70/30 with git churn, gives every file and function an importance from 0 to 1.",
  },
  {
    name: "Summarise",
    text: "The top files get a short summary from a local model, cached by content hash, so a re-run only pays for what changed.",
  },
  {
    name: "Ask",
    text: "Questions are answered from retrieved file and function chunks, and each answer lists the sources it drew on.",
  },
];

export function Landing() {
  const served = useServed();

  useEffect(() => {
    document.title = `${SITE.name}: map a codebase by what it depends on`;
  }, []);

  const openLabel = "Open the graph";

  return (
    <div className="landing">
      <header className="nav">
        <div className="shell nav-row">
          <Link href="/" className="wordmark" aria-label={`${SITE.name} home`}>
            <SynapseMark />
            {SITE.name}
          </Link>
          <nav className="nav-links" aria-label="Page sections">
            <a href="#how">How it works</a>
            <a href="#usage">Usage</a>
            <a href={SITE.repositoryUrl} className="nav-github">
              <GitHubIcon />
              <span>GitHub</span>
            </a>
          </nav>
          {served.state === "present" && (
            <Link href="/graph" className="button button-primary nav-open">
              {openLabel}
            </Link>
          )}
        </div>
      </header>

      <main>
        <section className="hero shell" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">Map a codebase by what it depends on.</h1>
            <p className="lead">
              Synapse turns a repository into a graph of its files and functions, ranks each
              file by how much the rest of the code relies on it, and lets you explore it in 3D
              or ask questions whose answers cite their sources. It runs on your machine.
            </p>

            <div className="hero-actions">
              {served.state === "present" ? (
                <Link href="/graph" className="button button-primary">
                  {openLabel}
                </Link>
              ) : (
                <a href="#usage" className="button button-primary">
                  Get started
                </a>
              )}
              <a href={SITE.repositoryUrl} className="button">
                <GitHubIcon />
                View on GitHub
              </a>
            </div>

            <p className="hero-status" aria-live="polite">
              {served.state === "present" &&
                (served.analysing
                  ? `Serving ${served.name}. The analysis is still running.`
                  : `Serving ${served.name}, ${served.fileCount?.toLocaleString() ?? "?"} files analysed.`)}
            </p>
          </div>

          <Suspense fallback={<div className="hero-figure hero-figure-pending" />}>
            <HeroGraph />
          </Suspense>
        </section>

        <section id="how" className="section shell" aria-labelledby="how-title">
          <div className="section-head">
            <h2 id="how-title">From source to a ranked map</h2>
            <p>
              Five stages, in order. Each one is plain, inspectable code, and every stage that
              can fail says what went wrong and how to fix it.
            </p>
          </div>

          <ol className="pipeline">
            {PIPELINE.map((stage) => (
              <li key={stage.name}>
                <h3>{stage.name}</h3>
                <p>{stage.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="section shell" aria-labelledby="features-title">
          <div className="section-head">
            <h2 id="features-title">Built for codebases you did not write</h2>
          </div>

          <dl className="features">
            <div>
              <dt>A ranked map, not a hairball</dt>
              <dd>
                The explorer opens on the few hundred files that matter most, even in a
                repository of eighteen thousand. A percentile slider brings the rest in, and
                every file stays one click from its summary, metrics and top functions.
              </dd>
            </div>
            <div>
              <dt>Answers you can check</dt>
              <dd>
                Ask in plain language. Retrieval balances whole-file and single-function
                context, every answer lists its sources, and clicking a source flies the camera
                to that file.
              </dd>
            </div>
            <div>
              <dt>Local first</dt>
              <dd>
                By default, summaries and answers come from Ollama on your machine and no code
                leaves it. Add <code>--provider anthropic</code> to use Claude instead, which
                sends each prompt, including excerpts of your source, to Anthropic’s API.
                Embeddings stay local either way, and the key is read only from{" "}
                <code>ANTHROPIC_API_KEY</code>.
              </dd>
            </div>
            <div>
              <dt>Private repositories</dt>
              <dd>
                Point it at a GitHub URL with <code>GITHUB_TOKEN</code> set. The token never
                reaches argv, the clone’s git config or your keychain, and it is scrubbed from
                every message Synapse prints.
              </dd>
            </div>
            <div>
              <dt>Holds up at scale</dt>
              <dd>
                Checked against home-assistant/core: 18,932 files and 107,106 imports, drawn in
                two draw calls and laid out in a background worker, so the page stays
                responsive while it settles.
              </dd>
            </div>
          </dl>
        </section>

        <section id="usage" className="section shell" aria-labelledby="usage-title">
          <div className="section-head">
            <h2 id="usage-title">Run it on your code</h2>
            <p>
              Needs Node 20 or later and git. Ollama is optional: without it you still get the
              graph and the rankings, just no summaries or questions.
            </p>
          </div>

          <ol className="steps">
            <li>
              <h3>Install</h3>
              <p>Clone and build. The command-line tool lands in <code>packages/cli/dist</code>.</p>
              <CommandBlock
                label="Install commands"
                commands={[
                  `git clone ${SITE.repositoryUrl}.git`,
                  `cd ${SITE.cloneDir}`,
                  "npm install",
                  "npm run build",
                ]}
              />
            </li>
            <li>
              <h3>Analyse a repository</h3>
              <p>
                The graph is cached in the project’s <code>.synapse/</code> folder. A GitHub URL
                works in place of a path, private ones included.
              </p>
              <CommandBlock label="Analyse command" commands={[`${CLI} analyze ${PROJECT}`]} />
            </li>
            <li>
              <h3>Explore it</h3>
              <p>Serves the explorer and opens it in your browser.</p>
              <CommandBlock label="Serve command" commands={[`${CLI} serve ${PROJECT}`]} />
            </li>
            <li>
              <h3>Ask questions</h3>
              <p>
                Pull the embedding model once, then ask from the explorer or the terminal. To
                answer with Claude, export <code>ANTHROPIC_API_KEY</code> and add{" "}
                <code>--provider anthropic</code>; prompts then go to Anthropic’s API.
              </p>
              <CommandBlock
                label="Ask commands"
                commands={[
                  "ollama pull nomic-embed-text",
                  `${CLI} ask "where is authentication handled?" --path ${PROJECT} --show-sources`,
                ]}
              />
            </li>
          </ol>
        </section>
      </main>

      <footer className="footer">
        <div className="shell footer-row">
          <span>{SITE.name} is open source under the MIT licence.</span>
          <a href={SITE.repositoryUrl} className="nav-github">
            <GitHubIcon />
            <span>Source on GitHub</span>
          </a>
        </div>
      </footer>
    </div>
  );
}

/** The wordmark's glyph: two nodes and the connection between them. */
function SynapseMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 16.5C9.5 16.5 10 7.5 17 7.5" fill="none" stroke="var(--edge-strong)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="6" cy="16.5" r="3" fill="var(--cyan)" />
      <circle cx="18" cy="7.5" r="3.5" fill="var(--amber)" />
    </svg>
  );
}

export function NotFound() {
  useEffect(() => {
    document.title = `Not found: ${SITE.name}`;
  }, []);

  return (
    <div className="landing not-found">
      <main className="shell">
        <h1>There is no page at {window.location.pathname}</h1>
        <p className="lead">
          The explorer lives at <Link href="/graph">/graph</Link>, and everything about Synapse
          is on the <Link href="/">home page</Link>.
        </p>
      </main>
    </div>
  );
}
