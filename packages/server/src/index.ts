import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ask,
  buildIndex,
  loadIndex,
  DEFAULT_EMBED_MODEL,
  DEFAULT_TOP_K,
  createProviders,
  defaultModelFor,
  type ProviderName,
  type RepoGraph,
} from "@synapse/core";

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
   * Reports the state of an analysis running in the background. The server starts
   * listening before the first analysis finishes so the UI can show progress, so it
   * needs a way to say "there is no graph yet, but one is on its way".
   */
  getAnalysis?: () => AnalysisState;
}

export interface AnalysisState {
  running: boolean;
  /** Latest progress line from the analysis pipeline. */
  message?: string;
  /** Set when the analysis failed; the UI shows this instead of spinning forever. */
  error?: string;
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
   * different one. The UI shows this so a user on --provider anthropic understands
   * why Ollama still has to be running.
   */
  provider: { chat: string; embed: string; note?: string };
  index: { exists: boolean; chunks?: number; dim?: number };
  /** True when /api/ask can be expected to work right now. */
  canAsk: boolean;
}

interface AskBody {
  question?: unknown;
  topK?: unknown;
  globalRank?: unknown;
}

interface IndexBody {
  embedModel?: unknown;
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

  const model = config.model ?? defaultModelFor(config.provider ?? "ollama");
  const embedModel = config.embedModel ?? DEFAULT_EMBED_MODEL;
  const graphFile = path.join(config.cacheDir, "graph.json");

  const readGraph = async (): Promise<RepoGraph | undefined> => {
    try {
      return JSON.parse(await readFile(graphFile, "utf8")) as RepoGraph;
    } catch {
      return undefined;
    }
  };

  app.get("/api/status", async (): Promise<StatusResponse> => {
    const providers = createProviders({
      provider: config.provider,
      model,
      embedModel,
      baseUrl: config.ollamaUrl,
    });

    // Chat may be Anthropic while embeddings are always Ollama, so each half is vetted
    // against its own backend and reported separately.
    const [chat, embed] = await Promise.all([
      providers.chat.preflight(model),
      providers.embed.preflight(embedModel),
    ]);

    // Ollama's reachability is whatever the embedding half saw — that is the half that
    // always talks to it, whichever provider is answering questions.
    const reachable = !(!embed.ok && /Could not reach Ollama/.test(embed.message));

    const graph = await readGraph();
    const store = await loadIndex(config.cacheDir, embedModel);

    return {
      root: config.root,
      ollama: { baseUrl: providers.embed.endpoint, reachable },
      provider: {
        chat: providers.chat.name,
        embed: providers.embed.name,
        note: providers.embedNote,
      },
      chatModel: { name: model, available: chat.ok, message: chat.ok ? undefined : chat.message },
      embedModel: {
        name: embedModel,
        available: embed.ok,
        message: embed.ok ? undefined : embed.message,
      },
      graph: graph
        ? { exists: true, fileCount: graph.stats.fileCount, generatedAt: graph.generatedAt }
        : { exists: false },
      analysis: config.getAnalysis?.() ?? { running: false },
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
          `No graph found at ${graphFile}.\n` +
          "  Run `synapse analyze <path>` first, or restart `synapse serve` to build one.",
      });
    }
    return graph;
  });

  app.post("/api/ask", async (request, reply) => {
    const body = (request.body ?? {}) as AskBody;

    if (typeof body.question !== "string" || body.question.trim() === "") {
      return reply.code(400).send({ error: "bad-request", message: "`question` must be a non-empty string." });
    }

    const graph = await readGraph();
    if (!graph) {
      return reply.code(409).send({
        error: "no-graph",
        message: "There is no graph to answer from yet. Run an analysis first.",
      });
    }

    const result = await ask(body.question, {
      root: config.root,
      graph,
      cacheDir: config.cacheDir,
      provider: config.provider,
      model,
      embedModel,
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

    const graph = await readGraph();
    if (!graph) {
      return reply.code(409).send({
        error: "no-graph",
        message: "There is no graph to index yet. Run an analysis first.",
      });
    }

    const report = await buildIndex(graph, {
      root: config.root,
      cacheDir: config.cacheDir,
      embedModel: typeof body.embedModel === "string" ? body.embedModel : embedModel,
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
