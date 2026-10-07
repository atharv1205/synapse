import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  analyze,
  ask,
  buildIndex,
  loadIndex,
  writeGraph,
  isRepoUrl,
  redactUrl,
  AnthropicClient,
  GeminiClient,
  OllamaClient,
  DEFAULT_TOP_K,
  API_KEY_ENV,
  GEMINI_KEY_ENV,
  createProviders,
  defaultModelFor,
  defaultEmbedModelFor,
  type AnalyzeOptions,
  type ProviderName,
  type RepoGraph,
  type RepositoryInfo,
} from "@synapse/core";

const PROVIDERS: ProviderName[] = ["ollama", "gemini", "anthropic"];

export interface ServerConfig {
  /** Root of the repo being served. */
  root: string;
  /** Folder with graph.json, summaries.json and the embedding index. */
  cacheDir: string;
  /** Built web app to serve, if any. Left out in dev since Vite serves it then. */
  webDist?: string;
  /**
   * Address we're bound to. On loopback, requests for any other host get refused (see
   * `isLoopback`).
   */
  host?: string;
  provider?: ProviderName;
  model?: string;
  embedModel?: string;
  ollamaUrl?: string;
  logger?: boolean;
  /**
   * Analysis to kick off as soon as the server is up, for `serve` on a target with no
   * graph yet. We start listening before it finishes so the UI can show progress.
   */
  initialAnalysis?: AnalysisJob;
  /**
   * Where repos analysed from the web page keep their files, one folder each, so opening
   * the same repo again is instant. Defaults to ~/.synapse-map/repos.
   */
  reposDir?: string;
  /** Gets every progress line, to print in the terminal. */
  onProgress?: (line: string) => void;
  /** Swap out core's analyze (for tests). */
  analyzer?: (target: string, options: AnalyzeOptions) => Promise<RepoGraph>;
}

/** One analysis: what to read, where its files go and how to summarise. */
export interface AnalysisJob {
  /** A path, or the URL to clone, including a credential if the user put one in. */
  target: string;
  /** What we show for it: the path, or the URL with the credential stripped. */
  root: string;
  cacheDir: string;
  /** Only used for the clone. Never stored, logged or sent back. */
  token?: string;
  provider?: ProviderName;
  skipSummarize?: boolean;
  skipGitHub?: boolean;
  summarizeTop?: number;
}

export interface AnalysisState {
  running: boolean;
  /** Latest progress line from the pipeline. */
  message?: string;
  /** Set if the analysis failed, so the UI shows it instead of spinning forever. */
  error?: string;
}

/** Whether a provider is usable right now, and if not, how to fix it. */
export interface ProviderAvailability {
  available: boolean;
  /** Chat model it would use. */
  model: string;
  message?: string;
}

/**
 * What the UI needs to pick between showing the graph, a loading state, or a fix-it
 * message.
 */
export interface StatusResponse {
  root: string;
  ollama: { baseUrl: string; reachable: boolean };
  chatModel: { name: string; available: boolean; message?: string };
  embedModel: { name: string; available: boolean; message?: string };
  graph: { exists: boolean; fileCount?: number; generatedAt?: number | string };
  /** GitHub's details for the served repo, if it's on GitHub. */
  repository?: RepositoryInfo;
  analysis: AnalysisState;
  /**
   * Which backend answers, plus a note on why embeddings might come from another one. The
   * UI shows it so someone on Claude gets why Ollama still needs to run.
   */
  provider: { chat: string; embed: string; note?: string };
  /** The provider `serve` started with. The page picks it by default. */
  defaultProvider: ProviderName;
  /** Every provider and whether it works right now, for the switch on the page. */
  providers: Record<ProviderName, ProviderAvailability>;
  index: { exists: boolean; chunks?: number; dim?: number };
  /** True if /api/ask should work right now. */
  canAsk: boolean;
}

interface AskBody {
  question?: unknown;
  topK?: unknown;
  globalRank?: unknown;
  provider?: unknown;
}

interface IndexBody {
  embedModel?: unknown;
  provider?: unknown;
}

interface AnalyzeBody {
  target?: unknown;
  token?: unknown;
  provider?: unknown;
  /** Analyse again even if this repo already has a graph. */
  reanalyze?: unknown;
}

/**
 * Where a repo analysed from the web page keeps its files:
 * <reposDir>/<host>/<owner>/<repo>. Every part is cut down to safe characters and `..`
 * can't get through, so a crafted URL can't write outside reposDir.
 */
export function repoCacheDir(reposDir: string, url: string): string {
  const parsed = new URL(url);
  const segments = [parsed.hostname, ...parsed.pathname.split("/")]
    .map((segment) => segment.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter((segment) => segment !== "" && !/^\.+$/.test(segment));
  return path.join(reposDir, ...segments);
}

/** Provider from a request: `undefined` if none was given, `null` if it's not valid. */
function providerIn(value: unknown): ProviderName | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return PROVIDERS.includes(value as ProviderName) ? (value as ProviderName) : null;
}

/**
 * Routes the web app renders itself. Anything else that isn't a file or an API route gets
 * the app's not-found page with a real 404, not a fake 200. Keep this in sync with the
 * route switch in packages/web/src/main.tsx.
 */
const APP_ROUTES = new Set(["/", "/graph"]);

/**
 * Sent on every response. The page doesn't load anything from other origins, so `'self'`
 * everywhere is enough. Inline styles are allowed because React and the 3D canvas set
 * style attributes. Framing is blocked: nothing needs to embed the explorer, and it stops
 * clickjacking on the Ask and Rebuild buttons.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopback(host: string | undefined): boolean {
  return host === undefined || LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

/** Hostname from a Host header, minus the port. Handles IPv4, names and [IPv6]. */
function hostnameOf(header: string | undefined): string {
  if (!header) return "";
  if (header.startsWith("[")) return header.slice(0, header.indexOf("]") + 1);
  return header.split(":")[0] ?? "";
}

/**
 * The HTTP layer on top of core. Every route is thin: read a file, or call one core
 * function and send back what it returns. No scoring, chunking, retrieval or fix-it logic
 * here. That all lives in core, and copying any of it would mean two behaviours to keep
 * in sync.
 */
export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.logger ?? false });

  // DNS rebinding guard. Any website can point its own hostname at 127.0.0.1 and then
  // talk to this server as if it were same-origin, reading the graph and summaries or
  // triggering model calls that cost money on a cloud provider. The browser still sends
  // that site's name in the Host header, so on a loopback bind we refuse anything not
  // addressed to a loopback name. Binding to a network address means you chose to be
  // reachable, so the check is skipped then.
  if (isLoopback(config.host)) {
    app.addHook("onRequest", async (request, reply) => {
      if (!LOOPBACK_HOSTS.has(hostnameOf(request.headers.host))) {
        return reply.code(403).send({
          error: "forbidden-host",
          message: "Synapse only answers requests addressed to localhost.",
        });
      }
    });
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    return payload;
  });

  const defaultProvider: ProviderName = config.provider ?? "ollama";
  const reposDir = config.reposDir ?? path.join(homedir(), ".synapse-map", "repos");
  const analyzer = config.analyzer ?? analyze;

  /**
   * Models for a provider. `--model` and `--embed-model` apply to the provider `serve`
   * started with. Any other provider the page switches to uses its own defaults, so we
   * don't end up sending an Ollama model name to Gemini.
   */
  const modelsFor = (provider: ProviderName) => ({
    model: (provider === defaultProvider ? config.model : undefined) ?? defaultModelFor(provider),
    embedModel: (provider === defaultProvider ? config.embedModel : undefined) ?? defaultEmbedModelFor(provider),
  });

  // The repo being served. It can change: analysing another repo from the page switches
  // the whole explorer over.
  const workspace = { root: config.root, cacheDir: config.cacheDir };
  let analysis: AnalysisState = { running: false };

  const readGraph = async (): Promise<RepoGraph | undefined> => {
    try {
      return JSON.parse(await readFile(path.join(workspace.cacheDir, "graph.json"), "utf8")) as RepoGraph;
    } catch {
      return undefined;
    }
  };

  function startAnalysis(job: AnalysisJob): void {
    workspace.root = job.root;
    workspace.cacheDir = job.cacheDir;
    analysis = { running: true };
    const provider = job.provider ?? defaultProvider;
    const report = (line: string) => {
      analysis.message = line;
      config.onProgress?.(line);
    };

    void (async () => {
      try {
        const graph = await analyzer(job.target, {
          cacheDir: job.cacheDir,
          token: job.token,
          provider,
          model: modelsFor(provider).model,
          ollamaUrl: config.ollamaUrl,
          skipSummarize: job.skipSummarize,
          skipGitHub: job.skipGitHub,
          summarizeTop: job.summarizeTop,
          onProgress: report,
        });
        await writeGraph(graph, job.cacheDir);
        config.onProgress?.(`Wrote ${path.join(job.cacheDir, "graph.json")}`);
        analysis = { running: false };
      } catch (error) {
        analysis = { running: false, error: error instanceof Error ? error.message : String(error) };
        config.onProgress?.(`Analysis failed: ${analysis.error}`);
      }
    })();
  }

  if (config.initialAnalysis) startAnalysis(config.initialAnalysis);

  /**
   * Whether each provider works right now. We ask Ollama directly since it's local. For
   * the cloud ones we just check the key is set, because hitting their APIs on every
   * status poll would add a round trip each time.
   */
  async function availability(): Promise<Record<ProviderName, ProviderAvailability>> {
    const local = modelsFor("ollama").model;
    const ollama = await new OllamaClient({ model: local, baseUrl: config.ollamaUrl }).preflight(local);
    const keyed = (has: boolean, env: string, provider: ProviderName): ProviderAvailability => ({
      available: has,
      model: modelsFor(provider).model,
      message: has ? undefined : `Set ${env} in the environment \`synapse serve\` runs in, then restart it.`,
    });
    return {
      ollama: { available: ollama.ok, model: local, message: ollama.ok ? undefined : ollama.message },
      gemini: keyed(GeminiClient.hasApiKey(), GEMINI_KEY_ENV, "gemini"),
      anthropic: keyed(AnthropicClient.hasApiKey(), API_KEY_ENV, "anthropic"),
    };
  }

  app.get("/api/status", async (request, reply): Promise<StatusResponse | undefined> => {
    const requested = providerIn((request.query as { provider?: unknown }).provider);
    if (requested === null) {
      reply.code(400).send({ error: "bad-request", message: `\`provider\` must be one of ${PROVIDERS.join(", ")}.` });
      return undefined;
    }
    const provider = requested ?? defaultProvider;
    const { model, embedModel } = modelsFor(provider);
    const providers = createProviders({ provider, model, embedModel, baseUrl: config.ollamaUrl });

    // Chat and embeddings can come from different backends (Claude answers, Ollama
    // embeds), so check each against its own backend and report them separately.
    const [chat, embed, list] = await Promise.all([
      providers.chat.preflight(model),
      providers.embed.preflight(embedModel),
      availability(),
    ]);

    const reachable = !(!list.ollama.available && /Could not reach Ollama/.test(list.ollama.message ?? ""));
    const graph = await readGraph();
    const store = await loadIndex(workspace.cacheDir, embedModel);

    return {
      root: workspace.root,
      ollama: { baseUrl: config.ollamaUrl ?? "http://localhost:11434", reachable },
      provider: { chat: providers.chat.name, embed: providers.embed.name, note: providers.embedNote },
      defaultProvider,
      providers: list,
      chatModel: { name: model, available: chat.ok, message: chat.ok ? undefined : chat.message },
      embedModel: { name: embedModel, available: embed.ok, message: embed.ok ? undefined : embed.message },
      graph: graph
        ? { exists: true, fileCount: graph.stats.fileCount, generatedAt: graph.generatedAt }
        : { exists: false },
      repository: graph?.repository,
      analysis,
      index: store.size > 0 ? { exists: true, chunks: store.size, dim: store.dim } : { exists: false },
      canAsk: chat.ok && embed.ok && graph !== undefined,
    };
  });

  app.get("/api/graph", async (request, reply) => {
    const graph = await readGraph();
    if (!graph) {
      return reply.code(404).send({
        error: "no-graph",
        message:
          `No graph found at ${path.join(workspace.cacheDir, "graph.json")}.\n` +
          "  Run `synapse analyze <path>` first, or restart `synapse serve` to build one.",
      });
    }
    return graph;
  });

  app.post("/api/analyze", async (request, reply) => {
    const body = (request.body ?? {}) as AnalyzeBody;
    const target = typeof body.target === "string" ? body.target.trim() : "";
    if (target === "") {
      return reply.code(400).send({ error: "bad-request", message: "Paste a GitHub URL or a local folder path." });
    }

    const provider = providerIn(body.provider);
    if (provider === null) {
      return reply.code(400).send({ error: "bad-request", message: `\`provider\` must be one of ${PROVIDERS.join(", ")}.` });
    }
    if (body.token !== undefined && typeof body.token !== "string") {
      return reply.code(400).send({ error: "bad-request", message: "`token` must be a string." });
    }
    if (analysis.running) {
      return reply.code(409).send({ error: "busy", message: "Another analysis is still running. Wait for it to finish." });
    }

    let job: AnalysisJob;
    if (isRepoUrl(target)) {
      // https only. The token gets to git through a credential helper that answers for
      // https; ssh and git@ URLs would use the machine's own keys instead.
      if (!/^https:\/\//i.test(target)) {
        return reply.code(400).send({ error: "bad-request", message: "Use the repository's https:// URL." });
      }
      let cacheDir: string;
      try {
        cacheDir = repoCacheDir(reposDir, target);
      } catch {
        return reply.code(400).send({ error: "bad-request", message: "That URL could not be read." });
      }
      job = { target, root: redactUrl(target), cacheDir };
    } else {
      const local = path.resolve(target.replace(/^~(?=$|\/)/, homedir()));
      const info = await stat(local).catch(() => undefined);
      if (!info?.isDirectory()) {
        return reply.code(400).send({ error: "bad-request", message: `No folder at ${local}.` });
      }
      job = { target: local, root: local, cacheDir: path.join(local, ".synapse") };
    }

    job.provider = provider ?? defaultProvider;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token !== "") job.token = token;

    // Repo analysed before? Open it straight from the cache.
    const cached = await stat(path.join(job.cacheDir, "graph.json")).catch(() => undefined);
    if (cached && body.reanalyze !== true) {
      workspace.root = job.root;
      workspace.cacheDir = job.cacheDir;
      analysis = { running: false };
      return { status: "ready", root: job.root };
    }

    startAnalysis(job);
    return reply.code(202).send({ status: "analysing", root: job.root });
  });

  app.post("/api/ask", async (request, reply) => {
    const body = (request.body ?? {}) as AskBody;

    if (typeof body.question !== "string" || body.question.trim() === "") {
      return reply.code(400).send({ error: "bad-request", message: "`question` must be a non-empty string." });
    }
    const requested = providerIn(body.provider);
    if (requested === null) {
      return reply.code(400).send({ error: "bad-request", message: `\`provider\` must be one of ${PROVIDERS.join(", ")}.` });
    }

    const graph = await readGraph();
    if (!graph) {
      return reply.code(409).send({
        error: "no-graph",
        message: "There is no graph to answer from yet. Run an analysis first.",
      });
    }

    const provider = requested ?? defaultProvider;
    const result = await ask(body.question, {
      root: workspace.root,
      graph,
      cacheDir: workspace.cacheDir,
      provider,
      ...modelsFor(provider),
      baseUrl: config.ollamaUrl,
      topK: typeof body.topK === "number" ? body.topK : DEFAULT_TOP_K,
      globalRank: body.globalRank === true,
    });

    // A failed ask isn't a server error. Core already wrote the fix-it text, so a 503
    // with that message is all we need.
    if (!result.ok) {
      return reply.code(503).send({ error: "unavailable", message: result.message ?? "Could not answer." });
    }

    return result;
  });

  app.post("/api/index", async (request, reply) => {
    const body = (request.body ?? {}) as IndexBody;
    const requested = providerIn(body.provider);
    if (requested === null) {
      return reply.code(400).send({ error: "bad-request", message: `\`provider\` must be one of ${PROVIDERS.join(", ")}.` });
    }

    const graph = await readGraph();
    if (!graph) {
      return reply.code(409).send({
        error: "no-graph",
        message: "There is no graph to index yet. Run an analysis first.",
      });
    }

    const provider = requested ?? defaultProvider;
    const models = modelsFor(provider);
    const report = await buildIndex(graph, {
      root: workspace.root,
      cacheDir: workspace.cacheDir,
      provider,
      embedModel: typeof body.embedModel === "string" ? body.embedModel : models.embedModel,
      baseUrl: config.ollamaUrl,
    });

    if (!report.ran) {
      return reply.code(503).send({ error: "unavailable", message: report.message, report });
    }

    return report;
  });

  if (config.webDist) {
    // The web build writes .br and .gz next to every asset. Serving those takes the page
    // from about 1MB to about 240KB for anyone not on localhost.
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/", preCompressed: true });

    // SPA fallback. The app's own routes get the HTML shell so a hard refresh still
    // works. Other page paths get the same shell (which shows the not-found page) but
    // with a 404, so crawlers and tools get the truth. A missing file like /robots.txt or
    // /favicon.ico gets a plain 404, not an HTML page.
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        return reply.code(404).send({ error: "not-found", message: `No route ${pathname}` });
      }
      if (path.extname(pathname) !== "") {
        return reply.code(404).type("text/plain").send("Not found");
      }
      const route = pathname.replace(/\/+$/, "") || "/";
      return reply.code(APP_ROUTES.has(route) ? 200 : 404).sendFile("index.html");
    });
  }

  return app;
}
