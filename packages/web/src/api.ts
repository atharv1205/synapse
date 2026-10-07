import type { RepoGraph, RepositoryInfo, Source } from "@synapse/core";

export type ProviderName = "ollama" | "gemini" | "anthropic";

/** Same order as the switch. */
export const PROVIDERS: ProviderName[] = ["ollama", "gemini", "anthropic"];

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  ollama: "Local",
  gemini: "Gemini",
  anthropic: "Claude",
};

export interface ProviderAvailability {
  available: boolean;
  /** Chat model it would use. */
  model: string;
  message?: string;
}

/** Same shape as the server's StatusResponse. */
export interface Status {
  root: string;
  ollama: { baseUrl: string; reachable: boolean };
  provider: { chat: string; embed: string; note?: string };
  defaultProvider: ProviderName;
  providers: Record<ProviderName, ProviderAvailability>;
  chatModel: { name: string; available: boolean; message?: string };
  embedModel: { name: string; available: boolean; message?: string };
  graph: { exists: boolean; fileCount?: number; generatedAt?: string };
  /** GitHub's details for the served repo, if it's on GitHub. */
  repository?: RepositoryInfo;
  analysis: { running: boolean; message?: string; error?: string };
  index: { exists: boolean; chunks?: number; dim?: number };
  canAsk: boolean;
}

export interface AskAnswer {
  ok: boolean;
  question: string;
  answer: string;
  sources: Source[];
}

export interface IndexReport {
  ran: boolean;
  embedModel: string;
  total: number;
  embedded: number;
  reused: number;
  dim: number;
  message?: string;
}

/**
 * An error that carries the server's own fix-it text. Core writes those messages ("run
 * ollama pull …", "run synapse analyze …") and the UI shows them as they are instead of
 * making up its own.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new ApiError(
      `Cannot reach the Synapse server at ${location.origin}.\n` +
        "Is `synapse serve` still running?",
      0,
      "unreachable",
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const detail = body as { message?: string; error?: string } | undefined;
    throw new ApiError(
      detail?.message ?? `Request to ${url} failed with ${response.status}`,
      response.status,
      detail?.error,
    );
  }

  return body as T;
}

export interface AnalyzeRequest {
  /** A GitHub https URL or a local folder path. */
  target: string;
  /** For private repos. Sent once for the clone; the server never stores it. */
  token?: string;
  provider?: ProviderName;
  reanalyze?: boolean;
}

export interface AnalyzeResponse {
  /** "ready" if the repo was analysed before and opens from the cache. */
  status: "ready" | "analysing";
  root: string;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  status: (provider?: ProviderName) =>
    request<Status>(provider ? `/api/status?provider=${provider}` : "/api/status"),

  graph: () => request<RepoGraph>("/api/graph"),

  ask: (question: string, provider?: ProviderName, topK?: number) =>
    request<AskAnswer>("/api/ask", json({ question, provider, topK })),

  buildIndex: (provider?: ProviderName) => request<IndexReport>("/api/index", json({ provider })),

  analyze: (body: AnalyzeRequest) => request<AnalyzeResponse>("/api/analyze", json(body)),
};

/** Last part of the served root, which is what people actually call the repo. */
export function repoNameOf(root: string): string {
  // A URL ends in `repo` or `repo.git`, a path ends in the folder name.
  return root.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") || root;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** 69000 → "69K", so star and fork counts are quick to read. */
export function compactCount(value: number): string {
  return compact.format(value);
}
