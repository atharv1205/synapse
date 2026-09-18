import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, writeGraph } from "@synapse/core";
import { createServer } from "@synapse/server";

export interface ServeOptions {
  root: string;
  cacheDir: string;
  port: number;
  host: string;
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

/** Locates the built web app, if it was built. */
async function findWebDist(): Promise<string | undefined> {
  // packages/cli/dist/src/serve.js -> packages/web/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../../../web/dist");
  try {
    await access(path.join(candidate, "index.html"));
    return candidate;
  } catch {
    return undefined;
  }
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

  if (!hasGraph) {
    console.error(`No graph at ${graphFile} — analysing ${options.root} first …`);
    const graph = await analyze(options.root, {
      cacheDir: options.cacheDir,
      model: options.model,
      ollamaUrl: options.ollamaUrl,
      skipSummarize: options.skipSummarize,
      summarizeTop: options.summarizeTop,
      onProgress: (message) => console.error(`  ${message}`),
    });
    await writeGraph(graph, options.cacheDir);
    console.error(`Wrote ${graphFile}`);
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
    model: options.model,
    embedModel: options.embedModel,
    ollamaUrl: options.ollamaUrl,
  });

  await app.listen({ port: options.port, host: options.host });

  const url = `http://localhost:${options.port}`;
  console.log(`\nSynapse is serving ${options.root}`);
  console.log(`  ${url}`);
  console.log(`  API: ${url}/api/status`);
  console.log("\nPress Ctrl+C to stop.");

  if (webDist && !options.noOpen) openBrowser(url);

  // Shut down cleanly so the port is released rather than left in TIME_WAIT on restart.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
