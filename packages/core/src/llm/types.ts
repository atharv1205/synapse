/** The outcome of a readiness check: either we can proceed, or here is exactly why not. */
export type Preflight = { ok: true } | { ok: false; message: string };

/** A JSON Schema constraining a model's structured output. */
export type JsonSchema = Record<string, unknown>;

export type ProviderName = "ollama" | "anthropic" | "gemini";

/**
 * What the summarisation and question-answering passes need from a model backend.
 *
 * Both clients implement this so the prompt-building code never learns which provider
 * it is talking to — only the transport changes. Embeddings are part of the interface
 * because a provider has to be able to state whether it offers them; a provider that
 * does not must say so rather than quietly producing something else.
 */
export interface LlmProvider {
  readonly name: ProviderName;
  /** The chat / summarisation model this provider will use. */
  readonly model: string;
  /** Human-readable endpoint, for status output. */
  readonly endpoint: string;
  /** False when the provider has no embeddings endpoint at all. */
  readonly supportsEmbeddings: boolean;

  /** Checks that the provider is reachable and the given model is usable. */
  preflight(model?: string): Promise<Preflight>;

  /** One completion returning prose. */
  generateText(prompt: string, options?: { maxTokens?: number }): Promise<string>;

  /** One completion constrained to `schema`, parsed into T. */
  generateJson<T>(prompt: string, schema: JsonSchema): Promise<T>;

  /**
   * Embeds a batch of texts. Providers without embeddings throw rather than
   * substituting another model, so a caller can never silently get vectors from
   * somewhere it did not ask for.
   */
  embed(texts: string[], model: string): Promise<number[][]>;
}

/**
 * Thrown when a provider is asked for embeddings it cannot produce.
 *
 * This is deliberately loud. Vectors from two different models are not comparable, so
 * quietly answering an embedding request with a different provider's model would
 * corrupt an index in a way that is very hard to notice.
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
