import { ApiError, GoogleGenAI } from "@google/genai";
import type { JsonSchema, LlmProvider, Preflight } from "./types.js";

/** Google's recommended fast model for code and agent work, as of writing this. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/**
 * `gemini-embedding-001`, not the newer `gemini-embedding-2`. The newer one returns a
 * single combined vector for a batch, but we embed chunks in batches and need one vector
 * per chunk. 001 gives one per input.
 */
export const DEFAULT_GEMINI_EMBED_MODEL = "gemini-embedding-001";

/** The key only ever comes from here. Not a flag, not a file, not a form field. */
export const GEMINI_KEY_ENV = "GEMINI_API_KEY";

/**
 * Smaller than the model's default 3,072 (Google lists 768 as a recommended size). Below
 * 3,072 the vectors aren't unit length, but the index normalises everything it stores and
 * every query, so cosine similarity still works.
 */
const EMBED_DIMENSIONS = 768;

const MISSING_KEY_MESSAGE =
  `${GEMINI_KEY_ENV} is not set.\n` +
  `  Export your key:  export ${GEMINI_KEY_ENV}=...\n` +
  "  Get one at https://aistudio.google.com/apikey\n" +
  "  Synapse only reads the key from the environment — never from a flag, a file or the\n" +
  "  web page, so it cannot end up in your shell history or committed to the repo.\n" +
  "  Or use the local model instead with --provider ollama.";

/**
 * The bits of the SDK we actually use. Tests swap in a fake here, same as for the other
 * providers, so the suite never calls the real API.
 */
export interface GeminiTransport {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }): Promise<{
      text?: string;
      promptFeedback?: { blockReason?: string };
      candidates?: Array<{ finishReason?: string }>;
    }>;
    embedContent(params: {
      model: string;
      contents: string[];
      config?: Record<string, unknown>;
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
    get(params: { model: string }): Promise<unknown>;
  };
}

export interface GeminiConfig {
  model?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Swap out the SDK (for tests). */
  transport?: GeminiTransport;
}

/** Turn the SDK's errors into messages that tell you what to do. */
function describe(error: unknown, model: string): string {
  if (error instanceof ApiError) {
    if (error.status === 400 && /api key/i.test(error.message)) {
      return `${GEMINI_KEY_ENV} was rejected by the API.\n  Check the key is current and not revoked.`;
    }
    if (error.status === 401 || error.status === 403) {
      return `This API key is not permitted to use "${model}".`;
    }
    if (error.status === 404) {
      return `The model "${model}" does not exist or is not available to this key.\n  Pick another with --model.`;
    }
    if (error.status === 429) {
      return "The Gemini API rate-limited this request.\n  Wait and try again, or use --provider ollama.";
    }
    return `Gemini API error ${error.status}: ${error.message}`;
  }
  if (error instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(error.message)) {
    return "Could not reach the Gemini API.\n  Check your network connection, or use --provider ollama.";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Refusals come back as a normal response with a reason, not as an error. */
function refusal(response: Awaited<ReturnType<GeminiTransport["models"]["generateContent"]>>): string | undefined {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) return `Gemini declined the request (${blocked}).`;
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(finish)) {
    return `Gemini stopped without answering (${finish}).`;
  }
  return undefined;
}

/**
 * Sends our existing prompts to the Gemini API, and handles embeddings too.
 *
 * Like the other clients it doesn't build prompts, it just gets the same text we'd send
 * to Ollama. Unlike Anthropic, Gemini has an embeddings endpoint, so Gemini mode doesn't
 * need Ollama at all.
 */
export class GeminiClient implements LlmProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  readonly endpoint = "https://generativelanguage.googleapis.com";
  readonly supportsEmbeddings = true;

  private readonly timeoutMs: number;
  private cached?: GeminiTransport;

  constructor(private readonly config: GeminiConfig = {}) {
    this.model = config.model ?? DEFAULT_GEMINI_MODEL;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  static hasApiKey(): boolean {
    return (process.env[GEMINI_KEY_ENV] ?? "").trim() !== "";
  }

  /** Created lazily, so making a client without a key isn't an error by itself. */
  private client(): GeminiTransport {
    if (this.config.transport) return this.config.transport;
    if (!GeminiClient.hasApiKey()) throw new Error(MISSING_KEY_MESSAGE);
    this.cached ??= new GoogleGenAI({
      apiKey: process.env[GEMINI_KEY_ENV]!.trim(),
      httpOptions: { timeout: this.timeoutMs },
    }) as unknown as GeminiTransport;
    return this.cached;
  }

  /** Check the key is set and the model exists, without spending tokens. */
  async preflight(model: string = this.model): Promise<Preflight> {
    if (!this.config.transport && !GeminiClient.hasApiKey()) {
      return { ok: false, message: MISSING_KEY_MESSAGE };
    }
    try {
      await this.client().models.get({ model });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describe(error, model) };
    }
  }

  async generateText(prompt: string, options: { maxTokens?: number } = {}): Promise<string> {
    const response = await this.request(() =>
      this.client().models.generateContent({
        model: this.model,
        contents: prompt,
        config: { maxOutputTokens: options.maxTokens ?? 16_000 },
      }),
    );
    const declined = refusal(response);
    if (declined) throw new Error(declined);
    return (response.text ?? "").trim();
  }

  async generateJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
    const response = await this.request(() =>
      this.client().models.generateContent({
        model: this.model,
        contents: prompt,
        // Gemini accepts JSON Schema directly via responseJsonSchema, so the shared
        // schema goes in untouched.
        config: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 4_000 },
      }),
    );
    const declined = refusal(response);
    if (declined) throw new Error(declined);
    if (!response.text) throw new Error("The Gemini API returned no text to parse.");
    return JSON.parse(response.text) as T;
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.request(() =>
      this.client().models.embedContent({
        model,
        contents: texts,
        config: { outputDimensionality: EMBED_DIMENSIONS },
      }),
    );

    const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
    // If the model squashed the batch into one vector, every chunk would quietly get the
    // same vector. One per input or we fail loudly.
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      throw new Error(
        `"${model}" returned ${vectors.length} embeddings for ${texts.length} inputs.\n` +
          `  Synapse needs one vector per chunk; use --embed-model ${DEFAULT_GEMINI_EMBED_MODEL}.`,
      );
    }
    return vectors;
  }

  private async request<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new Error(describe(error, this.model));
    }
  }
}
