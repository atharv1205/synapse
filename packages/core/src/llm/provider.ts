import { AnthropicClient, DEFAULT_ANTHROPIC_MODEL, type AnthropicConfig } from "./anthropic.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_MODEL, OllamaClient } from "./ollama.js";
import type { LlmProvider, ProviderName } from "./types.js";

export interface ProviderOptions {
  /** Which backend answers and summarises. Embeddings are always Ollama. */
  provider?: ProviderName;
  /** Chat model. Defaults to the chosen provider's own default. */
  model?: string;
  /** Embedding model, always resolved against Ollama. */
  embedModel?: string;
  /** Ollama base URL. */
  baseUrl?: string;
  timeoutMs?: number;
  effort?: AnthropicConfig["effort"];
}

/** The pair of backends a run uses, and why they are what they are. */
export interface ProviderPair {
  /** Summarises files and answers questions. */
  chat: LlmProvider;
  /** Produces embeddings. Always Ollama — see `embedNote`. */
  embed: LlmProvider;
  embedModel: string;
  /**
   * Set when chat and embeddings come from different providers, so the CLI and UI can
   * say so plainly instead of leaving the user to discover that Ollama is still
   * required after choosing --provider anthropic.
   */
  embedNote?: string;
}

/** The chat model a provider uses when none is named. */
export function defaultModelFor(provider: ProviderName): string {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL;
}

export function createChatProvider(options: ProviderOptions = {}): LlmProvider {
  const provider = options.provider ?? "ollama";

  if (provider === "anthropic") {
    return new AnthropicClient({
      model: options.model ?? DEFAULT_ANTHROPIC_MODEL,
      timeoutMs: options.timeoutMs,
      effort: options.effort,
    });
  }

  return new OllamaClient({
    model: options.model ?? DEFAULT_MODEL,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Embeddings are Ollama-only, whatever `--provider` says.
 *
 * Anthropic has no embeddings endpoint. Rather than silently swapping in some other
 * model — which would produce vectors that are not comparable with anything already in
 * the index — retrieval keeps using Ollama and the mismatch is reported.
 */
export function createEmbeddingProvider(options: ProviderOptions = {}): LlmProvider {
  return new OllamaClient({
    model: options.embedModel ?? DEFAULT_EMBED_MODEL,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  });
}

export function createProviders(options: ProviderOptions = {}): ProviderPair {
  const chat = createChatProvider(options);
  const embed = createEmbeddingProvider(options);
  const embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;

  return {
    chat,
    embed,
    embedModel,
    embedNote: chat.supportsEmbeddings
      ? undefined
      : `Answers come from ${chat.name} (${chat.model}), but embeddings have no ${chat.name} ` +
        `endpoint, so retrieval still uses Ollama (${embedModel}). Ollama must be running.`,
  };
}
