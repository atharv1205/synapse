/** Result of a readiness check: good to go, or exactly why not. */
export type Preflight = { ok: true } | { ok: false; message: string };

/** JSON Schema for a model's structured output. */
export type JsonSchema = Record<string, unknown>;

export type ProviderName = "ollama" | "anthropic" | "gemini";

/**
 * What summarising and Q&A need from a model backend.
 *
 * Every client implements this, so the prompt code never knows which provider it's
 * talking to. Only the transport changes. Embeddings are part of it because a provider
 * has to say whether it supports them, and one that doesn't has to say so instead of
 * quietly doing something else.
 */
export interface LlmProvider {
  readonly name: ProviderName;
  /** The chat/summary model this provider uses. */
  readonly model: string;
  /** Endpoint in readable form, for status output. */
  readonly endpoint: string;
  /** False if the provider has no embeddings endpoint. */
  readonly supportsEmbeddings: boolean;

  /** Check the provider is reachable and the model is usable. */
  preflight(model?: string): Promise<Preflight>;

  /** One completion that returns prose. */
  generateText(prompt: string, options?: { maxTokens?: number }): Promise<string>;

  /** One completion constrained to `schema`, parsed into T. */
  generateJson<T>(prompt: string, schema: JsonSchema): Promise<T>;

  /**
   * Embed a batch of texts. Providers without embeddings throw instead of using some
   * other model, so callers never get vectors from somewhere they didn't ask for.
   */
  embed(texts: string[], model: string): Promise<number[][]>;
}

/**
 * Thrown when a provider is asked for embeddings it can't make.
 *
 * This is loud on purpose. Vectors from different models don't mix, so quietly answering
 * with another provider's model would corrupt the index in a way that's really hard to
 * spot.
 */
export class EmbeddingsUnsupportedError extends Error {
  constructor(provider: ProviderName) {
    super(
      `The ${provider} provider has no embeddings endpoint.\n` +
        "  Synapse always embeds with Ollama, even when --provider anthropic is set for\n" +
        "  summaries and answers. Make sure Ollama is running:  ollama serve",
    );
    this.name = "EmbeddingsUnsupportedError";
  }
}
