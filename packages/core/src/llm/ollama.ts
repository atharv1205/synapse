import type { JsonSchema, LlmProvider, Preflight } from "./types.js";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
/**
 * Qwen2.5-Coder, as the spec asked for. It's trained on code, which is what all our
 * prompts are about. Any pulled chat model works with --model; qwen2.5:14b-instruct used
 * to be the default.
 */
export const DEFAULT_MODEL = "qwen2.5-coder:14b";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  /** Per-request timeout. Local models can be slow on a cold start, so it's generous. */
  timeoutMs?: number;
}


export type { JsonSchema, Preflight } from "./types.js";

interface GenerateResponse {
  response?: string;
  error?: string;
}

/**
 * Small client for Ollama's local HTTP API. Uses built-in fetch so no extra dependency.
 * "Ollama isn't set up" never throws; it comes back as a Preflight result the caller can
 * report and move past.
 */
export class OllamaClient implements LlmProvider {
  readonly name = "ollama" as const;
  readonly baseUrl: string;
  readonly model: string;
  /** Ollama serves embedding models too, so this provider does both. */
  readonly supportsEmbeddings = true;
  private readonly timeoutMs: number;

  /** Same as `baseUrl`. Part of the LlmProvider interface. */
  get endpoint(): string {
    return this.baseUrl;
  }

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  /** Model tags as Ollama lists them, e.g. `qwen2.5:14b-instruct`. */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status} from /api/tags`);

    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
  }

  /**
   * Ollama tags look like `name:tag`. Asking for `qwen2.5-coder` should match
   * `qwen2.5-coder:latest`, so if no tag was given we compare the bare name too.
   */
  private static matches(tag: string, requested: string): boolean {
    if (tag === requested) return true;
    if (!requested.includes(":")) return tag === `${requested}:latest` || tag.split(":")[0] === requested;
    return false;
  }

  /**
   * Check Ollama is up and the model is pulled. Returns what to do instead of throwing,
   * because a missing model shouldn't kill the whole analyse run.
   *
   * Takes the model as a parameter so one client can check both the chat model and the
   * embedding model.
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
          `  Start it with:  ollama serve`,
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
   * Embed a batch of texts. Uses the batch /api/embed endpoint, and falls back to the
   * older one-at-a-time /api/embeddings on servers that don't have it.
   *
   * Ollama only turns on embeddings for models that support them, so asking a chat model
   * to embed fails with some low-level llama.cpp error. We catch that and say "pull an
   * embedding model", since the raw error doesn't.
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

    // Old server with no /api/embed, use the fallback instead of failing.
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

  /** One non-streaming generation, returns the raw text. Used for prose answers. */
  async generateText(prompt: string, options: { maxTokens?: number } = {}): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: options.maxTokens ?? 800 },
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
   * One non-streaming generation constrained to `schema`. Ollama supports JSON Schema in
   * `format`, but we still parse loosely: models sometimes wrap the object in prose or a
   * code fence, and one bad file shouldn't stop the run.
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
        // Low temperature: we're describing real code, not writing fiction.
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
 * Make Ollama's embedding errors actionable. "does not support embeddings" means a
 * generation-only model is running and you need an embedding model. Restarting won't
 * help.
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

/** Parse JSON that might be inside a code fence or surrounded by extra text. */
export function parseJsonLoosely<T>(text: string): T {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Fall through to the extraction below.
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
