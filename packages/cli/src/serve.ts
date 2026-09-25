import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, writeGraph, type ProviderName } from "@synapse/core";
import { createServer, isLoopback, type AnalysisState } from "@synapse/server";

export interface ServeOptions {
  /** What is being served: a local path, or a repository URL with any credential removed. */
  root: string;
  /**
   * The URL to clone when the target is remote, credential included if the user put one
   * in it. Only the analysis sees this; everything printed or returned uses `root`.
   */
  cloneTarget?: string;
  cacheDir: string;
  port: number;
  host: string;
  provider?: ProviderName;
  /** Credential for cloning a private repository, if the target is a URL. */
  token?: string;
  model?: string;
  embedModel?: string;
  ollamaUrl?: string;
  skipSummarize?: boolean;
  summarizeTop?: number;
  /** Suppress opening a browser window. */
  noOpen?: boolean;
}

/** Opens a URL in the platform's default browser, best-effort. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // Detached and unref'd so the browser process does not keep the server alive.
    spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" })
      .unref();
  } catch {
    // Not being able to open a browser is not a reason to fail; the URL is printed anyway.
  }
}

/**
 * Locates the built web app. Two layouts are possible: the monorepo, where this file is
 * packages/cli/dist/src/serve.js beside packages/web/dist, and the published package,
 * where it is dist/cli/serve.js and the app ships in web/ at the package root.
 */
async function findWebDist(): Promise<string | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../../../web/dist"), path.resolve(here, "../../web")];

  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // Not this layout; try the next.
    }
  }
  return undefined;
}

/**
 * Runs an analysis if there is no graph yet, then serves the API and the built UI.
 *
 * Analysis degrades exactly as `analyze` does: a missing Ollama means no summaries, not
 * a failed start. The UI then reads /api/status and shows the same remediation text.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const graphFile = path.join(options.cacheDir, "graph.json");

  let hasGraph = true;
  try {
    await access(graphFile);
  } catch {
    hasGraph = false;
  }

  // Mutable so /api/status can read it on every request.
  const analysis: AnalysisState = { running: !hasGraph };

  const webDist = await findWebDist();
  if (!webDist) {
    console.error(
      "Note: the web app is not built, so only the API is being served.\n" +
        "  Build it with:  npm run build --workspace @synapse/web",
    );
  }

  const app = await createServer({
    root: options.root,
    cacheDir: options.cacheDir,
    webDist,
    host: options.host,
    provider: options.provider,
    model: options.model,
    embedModel: options.embedModel,
    ollamaUrl: options.ollamaUrl,
    getAnalysis: () => analysis,
  });

  await app.listen({ port: options.port, host: options.host });

  const url = `http://localhost:${options.port}`;
  console.log(`\nSynapse is serving ${options.root}`);
  console.log(`  Explorer: ${url}/graph`);
  console.log(`  About:    ${url}/`);
  console.log(`  API:      ${url}/api/status`);
  if (!isLoopback(options.host)) {
    console.log(
      `\nWarning: listening on ${options.host}, so anyone who can reach this machine can use\n` +
        "  the API. It has no authentication: they can read the graph and its summaries,\n" +
        "  and each question they ask runs the model, which costs money on --provider anthropic.",
    );
  }
  console.log("\nPress Ctrl+C to stop.");

  // Straight into the explorer: someone who ran `serve` came to use the tool, and the
  // landing page at / is one click away from its wordmark.
  if (webDist && !options.noOpen) openBrowser(`${url}/graph`);

  // The first analysis runs *after* the server is listening, not before it. Summarising
  // a repo takes minutes on a local model, and blocking the listen until it finished
  // meant the browser opened on a dead port and the UI's "analysing" state could never
  // be reached. Now /api/status answers immediately and reports progress.
  if (!hasGraph) {
    console.error(`No graph at ${graphFile} — analysing ${options.root} in the background …`);

    void (async () => {
      try {
        const graph = await analyze(options.cloneTarget ?? options.root, {
          cacheDir: options.cacheDir,
          token: options.token,
          provider: options.provider,
          model: options.model,
          ollamaUrl: options.ollamaUrl,
          skipSummarize: options.skipSummarize,
          summarizeTop: options.summarizeTop,
          onProgress: (message) => {
            analysis.message = message;
            console.error(`  ${message}`);
          },
        });
        await writeGraph(graph, options.cacheDir);
        console.error(`Wrote ${graphFile}`);
      } catch (error) {
        analysis.error = error instanceof Error ? error.message : String(error);
        console.error(`\nAnalysis failed: ${analysis.error}`);
      } finally {
        analysis.running = false;
        analysis.message = undefined;
      }
    })();
  }

  // Shut down cleanly so the port is released rather than left in TIME_WAIT on restart.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
