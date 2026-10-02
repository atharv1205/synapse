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
} from "@synapse/core";

const PROVIDERS: ProviderName[] = ["ollama", "gemini", "anthropic"];

export interface ServerConfig {
  /** Repo root being served. */
  root: string;
  /** Directory holding graph.json, summaries.json and the embedding index. */
  cacheDir: string;
  /** Built web app to serve, if there is one. Omitted in dev, where Vite serves it. */
  webDist?: string;
  /**
   * The address the server is bound to. On a loopback address, requests naming any
   * other host are refused; see `isLoopback` for why.
   */
  host?: string;
  provider?: ProviderName;
  model?: string;
  embedModel?: string;
  ollamaUrl?: string;
  logger?: boolean;
  /**
   * An analysis to start as soon as the server exists, for `serve` on a target with no
   * graph yet. The server listens before it finishes so the UI can show progress.
   */
  initialAnalysis?: AnalysisJob;
  /**
   * Where repositories analysed from the web page keep their artefacts, one folder per
   * repository, so opening the same one again is instant. Defaults to
   * ~/.synapse-map/repos.
   */
  reposDir?: string;
  /** Receives every progress line, for printing to the terminal. */
  onProgress?: (line: string) => void;
  /** Replaces core's analyze, for tests. */
  analyzer?: (target: string, options: AnalyzeOptions) => Promise<RepoGraph>;
}

/** One analysis: what to read, where its artefacts go, and how to summarise it. */
export interface AnalysisJob {
  /** A path, or the URL to clone, credential included if the user put one in it. */
  target: string;
  /** What to show for it: the path, or the URL with any credential removed. */
  root: string;
  cacheDir: string;
  /** Used for the clone only; never stored, logged or returned. */
  token?: string;
  provider?: ProviderName;
  skipSummarize?: boolean;
  summarizeTop?: number;
}

export interface AnalysisState {
  running: boolean;
  /** Latest progress line from the analysis pipeline. */
  message?: string;
  /** Set when the analysis failed; the UI shows this instead of spinning forever. */
  error?: string;
}

/** Whether one provider can be used right now, and if not, what would fix it. */
export interface ProviderAvailability {
  available: boolean;
  /** The chat model it would use. */
  model: string;
  message?: string;
}

/** What the UI needs to decide between rendering, a loading state, or remediation. */
export interface StatusResponse {
  root: string;
  ollama: { baseUrl: string; reachable: boolean };
  chatModel: { name: string; available: boolean; message?: string };
  embedModel: { name: string; available: boolean; message?: string };
  graph: { exists: boolean; fileCount?: number; generatedAt?: number | string };
  analysis: AnalysisState;
  /**
   * Which backend answers, and the note explaining why embeddings may come from a
   * different one. The UI shows this so a user on Claude understands why Ollama still
   * has to be running.
   */
  provider: { chat: string; embed: string; note?: string };
  /** The provider `serve` was started with, which the page selects by default. */
  defaultProvider: ProviderName;
  /** Every provider and whether it can be used now, for the page's switch. */
  providers: Record<ProviderName, ProviderAvailability>;
  index: { exists: boolean; chunks?: number; dim?: number };
  /** True when /api/ask can be expected to work right now. */
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
  /** Analyse again even if this repository already has a graph. */
  reanalyze?: unknown;
}

/**
 * Where a repository analysed from the web page keeps its artefacts:
 * <reposDir>/<host>/<owner>/<repo>. Every segment is reduced to safe characters and `..`
 * cannot survive, so a crafted URL cannot write outside reposDir.
 */
export function repoCacheDir(reposDir: string, url: string): string {
  const parsed = new URL(url);
  const segments = [parsed.hostname, ...parsed.pathname.split("/")]
    .map((segment) => segment.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter((segment) => segment !== "" && !/^\.+$/.test(segment));
  return path.join(reposDir, ...segments);
}

/** The provider named in a request, `undefined` if none was given, or `null` if invalid. */
function providerIn(value: unknown): ProviderName | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return PROVIDERS.includes(value as ProviderName) ? (value as ProviderName) : null;
}

/**
 * Client-side routes the web app renders. Anything else that is not a file or an API
 * route gets the app's not-found page with a real 404, not a soft 200. Keep in step
 * with the route switch in packages/web/src/main.tsx.
 */
const APP_ROUTES = new Set(["/", "/graph"]);

/**
 * Sent with every response. The page loads nothing from another origin, so the policy
 * can be `'self'` throughout; inline styles are allowed because React and the 3D canvas
 * set element style attributes. Framing is refused outright: nothing needs to embed the
 * explorer, and refusing it rules out clickjacking the Ask and Rebuild buttons.
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

/** The hostname part of a Host header, without the port, for IPv4, names and [IPv6]. */
function hostnameOf(header: string | undefined): string {
  if (!header) return "";
  if (header.startsWith("[")) return header.slice(0, header.indexOf("]") + 1);
  return header.split(":")[0] ?? "";
}

/**
 * The HTTP surface over the analysis core. Every route is a thin wrapper: read a file,
 * or call one core function and serialise what it returns. No scoring, chunking,
 * retrieval or remediation logic lives here — that all belongs to core, and duplicating
 * any of it would mean two behaviours to keep in step.
 */
export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.logger ?? false });

  // DNS rebinding guard. A page on any website can point its own hostname at
  // 127.0.0.1 and then talk to this server as if it were same-origin, reading the
  // graph and summaries or starting model calls that cost money on the Anthropic
  // provider. The browser still sends that website's name in the Host header, so on a
  // loopback bind anything not addressed to a loopback name is refused. Binding to a
  // network address is an explicit choice to be reachable, and skips the check.
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
   * The models a provider uses. `--model` and `--embed-model` were given for the
   * provider `serve` started with; any other provider the page switches to gets its own
   * defaults rather than, say, an Ollama model name sent to Gemini.
   */
  const modelsFor = (provider: ProviderName) => ({
    model: (provider === defaultProvider ? config.model : undefined) ?? defaultModelFor(provider),
    embedModel: (provider === defaultProvider ? config.embedModel : undefined) ?? defaultEmbedModelFor(provider),
  });

  // The repository being served. Mutable: analysing another one from the page switches
  // the whole explorer over to it.
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
   * Whether each provider is usable now. Ollama is asked directly, which is a local call;
   * the cloud providers are judged by whether their key is set, because asking their
   * APIs on every status poll would cost a round trip each time.
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
    // embeds), so each half is vetted against its own backend and reported separately.
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
      // https only: the token reaches git through a credential helper that answers
      // https; ssh and git@ forms would use the machine's own keys instead.
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

    // A repository analysed before opens straight from its cache.
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

    // A failed ask is a reportable state, not a server error: core already produced the
    // remediation text, so 503 plus that message is the whole response.
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
    // The web build writes .br and .gz beside each asset; serving those cuts the page
    // from about 1MB to about 240KB for any client that is not on loopback.
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/", preCompressed: true });

    // SPA fallback. The app's own routes get the shell so client-side routing survives
    // a hard refresh. Other page paths get the same shell, which renders the not-found
    // page, but with a 404 so crawlers and tools see the truth. A missing file such as
    // /robots.txt or /favicon.ico gets a plain 404 instead of an HTML page.
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
