export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_MODEL = "qwen2.5:14b-instruct";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  /** Per-request timeout. Local models on cold start can be slow, hence the generous default. */
  timeoutMs?: number;
}

/** The outcome of a preflight check: either we can summarise, or here is exactly why not. */
export type Preflight = { ok: true } | { ok: false; message: string };

/** A JSON Schema passed to Ollama's structured-output `format` field. */
export type JsonSchema = Record<string, unknown>;

interface GenerateResponse {
  response?: string;
  error?: string;
}

/**
 * A thin client over Ollama's local HTTP API. Uses the built-in fetch, so it adds
 * no dependency, and never throws for "Ollama isn't set up" — that is a Preflight
 * result the caller can report and continue past.
 */
export class OllamaClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  /** Model tags as Ollama reports them, e.g. `qwen2.5:14b-instruct`. */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status} from /api/tags`);

    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
  }

  /**
   * Ollama tags are `name:tag`. A user who asks for `qwen2.5-coder` should match the
   * pulled `qwen2.5-coder:latest`, so compare the bare name too when none was given.
   */
  private static matches(tag: string, requested: string): boolean {
    if (tag === requested) return true;
    if (!requested.includes(":")) return tag === `${requested}:latest` || tag.split(":")[0] === requested;
    return false;
  }

  /**
   * Checks that Ollama is up and the model is pulled. Returns remediation rather than
   * throwing, because a missing model must not take down the whole analyse run.
   *
   * Takes an explicit model so the same client can vet both the chat model and the
   * embedding model without a second client.
   */
  async preflight(model: string = this.model): Promise<Preflight> {
    let tags: string[];
    try {
      tags = await this.listModels();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message:
          `Could not reach Ollama at ${this.baseUrl} (${reason}).\n` +
          `  Start it with:  ollama serve\n` +
          `  Or re-run with --skip-summarize to analyse without summaries.`,
      };
    }

    if (!tags.some((tag) => OllamaClient.matches(tag, model))) {
      const available = tags.length > 0 ? tags.join(", ") : "(none)";
      return {
        ok: false,
        message:
          `Ollama is running at ${this.baseUrl}, but the model "${model}" is not pulled.\n` +
          `  Pull it with:   ollama pull ${model}\n` +
          `  Models present: ${available}`,
      };
    }

    return { ok: true };
  }

  /**
   * Embeds a batch of texts. Prefers the batch /api/embed endpoint and falls back to
   * the older one-at-a-time /api/embeddings for servers that predate it.
   *
   * Ollama starts a runner per model and only enables embeddings for models that
   * support them, so asking a chat model to embed fails with a llama.cpp-level error.
   * That case gets its own remediation, because "pull an embedding model" is the fix
   * and the raw error does not say so.
   */
  async embed(texts: string[], model: string): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batch = await this.tryBatchEmbed(texts, model);
    if (batch) return batch;

    const out: number[][] = [];
    for (const text of texts) out.push(await this.embedOne(text, model));
    return out;
  }

  private async tryBatchEmbed(texts: string[], model: string): Promise<number[][] | undefined> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // A server without /api/embed at all: fall back rather than fail.
    if (response.status === 404) return undefined;

    const body = (await response.json()) as { embeddings?: number[][]; error?: string };
    if (body.error) throw embeddingError(body.error, model);
    if (!response.ok) throw new Error(`Ollama returned ${response.status} from /api/embed`);
    if (!Array.isArray(body.embeddings)) return undefined;

    return body.embeddings;
  }

  private async embedOne(text: string, model: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = (await response.json()) as { embedding?: number[]; error?: string };
    if (body.error) throw embeddingError(body.error, model);
    if (!response.ok) throw new Error(`Ollama returned ${response.status} from /api/embeddings`);
    if (!Array.isArray(body.embedding)) throw new Error("Ollama returned no embedding");

    return body.embedding;
  }

  /** Runs one non-streaming generation and returns the raw text, for prose answers. */
  async generateText(prompt: string, options: { numPredict?: number } = {}): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: options.numPredict ?? 800 },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const body = (await response.json()) as GenerateResponse;
    if (body.error) throw new Error(`Ollama error: ${body.error}`);
    if (typeof body.response !== "string") throw new Error("Ollama returned no response text");

    return body.response.trim();
  }

  /**
   * Runs one non-streaming generation constrained to `schema`. Ollama honours JSON
   * Schema in `format`, but we still parse defensively: a model can emit the object
   * wrapped in prose or a fenced block, and one malformed file should not abort the run.
   */
  async generateJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: schema,
        // Low temperature: these are descriptions of real code, not creative writing.
        options: { temperature: 0.1, num_predict: 600 },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const body = (await response.json()) as GenerateResponse;
    if (body.error) throw new Error(`Ollama error: ${body.error}`);
    if (typeof body.response !== "string") throw new Error("Ollama returned no response text");

    return parseJsonLoosely<T>(body.response);
  }
}

/**
 * Turns Ollama's embedding errors into something actionable. A server that reports it
 * "does not support embeddings" is running a generation-only model, and the fix is to
 * use a model built for embeddings — not to restart anything.
 */
export function embeddingError(raw: string, model: string): Error {
  if (/does not support embeddings/i.test(raw)) {
    return new Error(
      `The model "${model}" cannot produce embeddings (Ollama said: ${raw}).\n` +
        `  Use a dedicated embedding model, e.g.:  ollama pull ${DEFAULT_EMBED_MODEL}\n` +
        `  Then re-run with --embed-model ${DEFAULT_EMBED_MODEL}`,
    );
  }
  return new Error(`Ollama embedding error: ${raw}`);
}

/** Parses JSON that may be wrapped in a fenced block or surrounded by stray prose. */
export function parseJsonLoosely<T>(text: string): T {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Fall through to extraction below.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      // Fall through.
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }

  throw new Error(`Model did not return JSON: ${trimmed.slice(0, 120)}`);
}
