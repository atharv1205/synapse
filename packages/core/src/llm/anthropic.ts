import Anthropic from "@anthropic-ai/sdk";
import {
  EmbeddingsUnsupportedError,
  type JsonSchema,
  type LlmProvider,
  type Preflight,
} from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/** The key only ever comes from here. No flag, no file. */
export const API_KEY_ENV = "ANTHROPIC_API_KEY";

export interface AnthropicConfig {
  model?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /**
   * Thinking effort. Summaries and short answers don't need deep reasoning, so it's low
   * by default. Thinking stays on (turning it off completely has its own problems) but
   * it's cheap.
   */
  effort?: "low" | "medium" | "high";
}

const MISSING_KEY_MESSAGE =
  `${API_KEY_ENV} is not set.\n` +
  `  Export your key:  export ${API_KEY_ENV}=sk-ant-...\n` +
  "  Synapse only reads the key from the environment — never from a flag or a file,\n" +
  "  so it cannot end up in your shell history or committed to the repo.\n" +
  "  Or use the local model instead with --provider ollama.";

/**
 * Mark every object in a schema as closed, recursively.
 *
 * Structured outputs in the Messages API need `additionalProperties: false` on each
 * object. Doing it here instead of in the shared schema means the prompt code stays the
 * same for every provider, which is the whole point.
 */
function closeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) out[key] = closeSchema(value);

  if (out.type === "object" && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

/** Turn the SDK's typed errors into messages that tell you what to do. */
function describe(error: unknown, model: string): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return `${API_KEY_ENV} was rejected by the API.\n  Check the key is current and not revoked.`;
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `This API key is not permitted to use "${model}".`;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `The model "${model}" does not exist or is not available to this key.\n  Pick another with --model.`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The Anthropic API rate-limited this request after retries.\n  Wait and try again, or use --provider ollama.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API.\n  Check your network connection, or use --provider ollama.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends our existing prompts to the Anthropic Messages API.
 *
 * It doesn't build any prompts itself. Summaries and Q&A give it exactly the text they'd
 * send to Ollama; only the transport is different.
 */
export class AnthropicClient implements LlmProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  readonly endpoint = "https://api.anthropic.com";
  readonly supportsEmbeddings = false;

  private readonly timeoutMs: number;
  private readonly effort: "low" | "medium" | "high";
  private cached?: Anthropic;

  constructor(config: AnthropicConfig = {}) {
    this.model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.effort = config.effort ?? "low";
  }

  static hasApiKey(): boolean {
    return (process.env[API_KEY_ENV] ?? "").trim() !== "";
  }

  /** Created lazily, so making a client without a key isn't an error by itself. */
  private client(): Anthropic {
    if (!AnthropicClient.hasApiKey()) throw new Error(MISSING_KEY_MESSAGE);
    this.cached ??= new Anthropic({ timeout: this.timeoutMs });
    return this.cached;
  }

  /**
   * Check the key is set and the model exists without spending tokens. `models.retrieve`
   * is just a metadata lookup.
   */
  async preflight(model: string = this.model): Promise<Preflight> {
    if (!AnthropicClient.hasApiKey()) return { ok: false, message: MISSING_KEY_MESSAGE };

    try {
      await this.client().models.retrieve(model);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describe(error, model) };
    }
  }

  async generateText(prompt: string, options: { maxTokens?: number } = {}): Promise<string> {
    try {
      const response = await this.client().messages.create({
        model: this.model,
        max_tokens: options.maxTokens ?? 16_000,
        output_config: { effort: this.effort },
        messages: [{ role: "user", content: prompt }],
      });

      if (response.stop_reason === "refusal") {
        throw new Error(
          `The model declined to answer (${response.stop_details?.category ?? "unspecified"}).`,
        );
      }

      // content is a union, narrow it before reading text.
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    } catch (error) {
      throw new Error(describe(error, this.model));
    }
  }

  async generateJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
    try {
      const response = await this.client().messages.create({
        model: this.model,
        max_tokens: 4_000,
        output_config: {
          effort: this.effort,
          format: { type: "json_schema", schema: closeSchema(schema) as Record<string, unknown> },
        },
        messages: [{ role: "user", content: prompt }],
      });

      if (response.stop_reason === "refusal") {
        throw new Error(
          `The model declined to summarise (${response.stop_details?.category ?? "unspecified"}).`,
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (!text) throw new Error("The API returned no text to parse.");
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(describe(error, this.model));
    }
  }

  async embed(): Promise<number[][]> {
    throw new EmbeddingsUnsupportedError("anthropic");
  }
}
