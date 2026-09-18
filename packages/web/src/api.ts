import type { RepoGraph, Source } from "@synapse/core";

/** Mirrors the server's StatusResponse. */
export interface Status {
  root: string;
  ollama: { baseUrl: string; reachable: boolean };
  chatModel: { name: string; available: boolean; message?: string };
  embedModel: { name: string; available: boolean; message?: string };
  graph: { exists: boolean; fileCount?: number; generatedAt?: string };
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
 * An error carrying the server's own remediation text. Core produces those messages —
 * "run ollama pull …", "run synapse analyze …" — and the UI shows them verbatim rather
 * than inventing its own wording.
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

export const api = {
  status: () => request<Status>("/api/status"),

  graph: () => request<RepoGraph>("/api/graph"),

  ask: (question: string, topK?: number) =>
    request<AskAnswer>("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, topK }),
    }),

  buildIndex: () =>
    request<IndexReport>("/api/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
};
