import { AnthropicClient, DEFAULT_ANTHROPIC_MODEL, type AnthropicConfig } from "./anthropic.js";
import { DEFAULT_GEMINI_EMBED_MODEL, DEFAULT_GEMINI_MODEL, GeminiClient } from "./gemini.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_MODEL, OllamaClient } from "./ollama.js";
import type { LlmProvider, ProviderName } from "./types.js";

export interface ProviderOptions {
  /**
   * Who answers and summarises. Embeddings come from the same backend if it has an
   * embeddings endpoint (Gemini), otherwise from Ollama (Anthropic).
   */
  provider?: ProviderName;
  /** Chat model. Falls back to the provider's default. */
  model?: string;
  /** Embedding model, for whichever backend does the embedding. */
  embedModel?: string;
  /** Ollama base URL. */
  baseUrl?: string;
  timeoutMs?: number;
  effort?: AnthropicConfig["effort"];
}

/** The two backends a run uses, and why. */
export interface ProviderPair {
  /** Summarises files and answers questions. */
  chat: LlmProvider;
  /** Does embeddings: Gemini in Gemini mode, Ollama otherwise (see `embedNote`). */
  embed: LlmProvider;
  embedModel: string;
  /**
   * Set when chat and embeddings come from different providers, so the CLI and UI can
   * just say it, instead of the user finding out Ollama is still needed after picking
   * --provider anthropic.
   */
  embedNote?: string;
}

/** Default chat model for a provider. */
export function defaultModelFor(provider: ProviderName): string {
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  if (provider === "gemini") return DEFAULT_GEMINI_MODEL;
  return DEFAULT_MODEL;
}

/**
 * Default embedding model for a provider. Changing it changes the vectors, so the
 * question index gets rebuilt. Vectors from two models can't be compared.
 */
export function defaultEmbedModelFor(provider: ProviderName = "ollama"): string {
  return provider === "gemini" ? DEFAULT_GEMINI_EMBED_MODEL : DEFAULT_EMBED_MODEL;
}

export function createChatProvider(options: ProviderOptions = {}): LlmProvider {
  const provider = options.provider ?? "ollama";

  if (provider === "gemini") {
    return new GeminiClient({ model: options.model ?? DEFAULT_GEMINI_MODEL, timeoutMs: options.timeoutMs });
  }

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
 * Gemini embeds with Gemini, so Gemini mode doesn't need Ollama. Anthropic has no
 * embeddings endpoint. Instead of quietly swapping in some other model (whose vectors
 * wouldn't match what's already in the index), we keep using Ollama for retrieval and say
 * so.
 */
export function createEmbeddingProvider(options: ProviderOptions = {}): LlmProvider {
  const provider = options.provider ?? "ollama";
  if (provider === "gemini") {
    return new GeminiClient({ timeoutMs: options.timeoutMs });
  }
  return new OllamaClient({
    model: options.embedModel ?? DEFAULT_EMBED_MODEL,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  });
}

export function createProviders(options: ProviderOptions = {}): ProviderPair {
  const chat = createChatProvider(options);
  const embed = createEmbeddingProvider(options);
  const embedModel = options.embedModel ?? defaultEmbedModelFor(options.provider);

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
