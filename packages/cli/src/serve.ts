import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderName } from "@synapse/core";
import { createServer, isLoopback } from "@synapse/server";

export interface ServeOptions {
  /** What we're serving: a local path, or a repo URL with any credential removed. */
  root: string;
  /**
   * The URL to clone when the target is remote, including a credential if the user put
   * one in. Only the analysis sees this; everything we print or return uses `root`.
   */
  cloneTarget?: string;
  cacheDir: string;
  port: number;
  host: string;
  provider?: ProviderName;
  /** Token for cloning a private repo, if the target is a URL. */
  token?: string;
  model?: string;
  embedModel?: string;
  ollamaUrl?: string;
  skipSummarize?: boolean;
  skipGitHub?: boolean;
  summarizeTop?: number;
  /** Don't open a browser window. */
  noOpen?: boolean;
}

/** Try to open a URL in the default browser. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // Detached and unref'd so the browser doesn't keep the server alive.
    spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" })
      .unref();
  } catch {
    // Couldn't open a browser? Not worth failing over, the URL gets printed anyway.
  }
}

/**
 * Find the built web app. Two possible layouts: in the monorepo this file is
 * packages/cli/dist/src/serve.js next to packages/web/dist, and in the published package
 * it's dist/cli/serve.js with the app in web/ at the root.
 */
async function findWebDist(): Promise<string | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../../../web/dist"), path.resolve(here, "../../web")];

  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // Not this layout, try the next one.
    }
  }
  return undefined;
}

/**
 * Analyse if there's no graph yet, then serve the API and the UI.
 *
 * Analysis degrades the same way `analyze` does: no Ollama just means no summaries, not a
 * failed start. The UI reads /api/status and shows the same fix-it text.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const graphFile = path.join(options.cacheDir, "graph.json");

  let hasGraph = true;
  try {
    await access(graphFile);
  } catch {
    hasGraph = false;
  }

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
    // The first analysis starts along with the server and runs while it's listening.
    // Summaries take minutes on a local model, and waiting for that before listening
    // meant the browser opened on a dead port. Now /api/status shows progress right away.
    initialAnalysis: hasGraph
      ? undefined
      : {
          target: options.cloneTarget ?? options.root,
          root: options.root,
          cacheDir: options.cacheDir,
          token: options.token,
          provider: options.provider,
          skipSummarize: options.skipSummarize,
          skipGitHub: options.skipGitHub,
          summarizeTop: options.summarizeTop,
        },
    onProgress: (line) => console.error(`  ${line}`),
  });

  if (!hasGraph) {
    console.error(`No graph at ${graphFile} — analysing ${options.root} in the background …`);
  }

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
        "  and each question they ask runs the model, which costs money on a cloud provider.",
    );
  }
  console.log("\nPress Ctrl+C to stop.");

  // Go straight to the explorer. If you ran `serve` you came to use the tool, and the
  // landing page at / is one click away from the logo.
  if (webDist && !options.noOpen) openBrowser(`${url}/graph`);

  // Shut down cleanly so the port is freed instead of sitting in TIME_WAIT on restart.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
