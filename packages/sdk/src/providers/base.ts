/**
 * @fileoverview Base provider interface for all AI providers
 * Each provider must implement this interface with their specific API format
 */

import type { AgentConfig, Message, Provider } from "@socratic-council/shared";

export type ChatAttachmentKind = "image" | "pdf";

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  data: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  cacheControl?: "ephemeral";
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  disableThinking?: boolean;
}

export interface CompletionResult {
  content: string;
  thinking?: string;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
  };
  finishReason: "stop" | "length" | "error";
  latencyMs: number;
}

export interface StreamChunk {
  content: string;
  thinking?: string;
  done: boolean;
}

export type StreamCallback = (chunk: StreamChunk) => void;

/**
 * Base provider interface that all AI providers must implement
 */
export interface BaseProvider {
  readonly provider: Provider;
  readonly apiKey: string;

  /**
   * Generate a completion from the provider
   */
  complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult>;

  /**
   * Generate a streaming completion from the provider
   */
  completeStream(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: StreamCallback,
    options?: CompletionOptions,
  ): Promise<CompletionResult>;

  /**
   * Test the connection to the provider. The optional `model` lets callers
   * pin the test to a specific model id — typically the user's locked
   * `LOCKED_MODELS[provider]` so the test exercises the same model the
   * council will actually use, rather than a stale hardcoded id.
   * Implementations should fall back to a known-stable test model when
   * the parameter is omitted.
   */
  testConnection(model?: string): Promise<boolean>;
}

/**
 * Create provider-specific headers
 */
export function createHeaders(provider: Provider, apiKey: string): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (provider) {
    case "openai":
      return {
        ...baseHeaders,
        Authorization: `Bearer ${apiKey}`,
      };
    case "anthropic":
      // Fix 4.5: include the prompt-caching beta header so `cacheControl: "ephemeral"`
      // on user messages actually engages the cache. Without this header
      // Anthropic ignores cache_control and bills every request as a full
      // re-prompt (5-10× cost overhead on long debates).
      return {
        ...baseHeaders,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      };
    case "google":
      return {
        ...baseHeaders,
        "x-goog-api-key": apiKey,
      };
    case "deepseek":
      return {
        ...baseHeaders,
        Authorization: `Bearer ${apiKey}`,
      };
    case "kimi":
      return {
        ...baseHeaders,
        Authorization: `Bearer ${apiKey}`,
      };
    case "qwen":
      return {
        ...baseHeaders,
        Authorization: `Bearer ${apiKey}`,
      };
    case "minimax":
      // MiniMax exposes an Anthropic-compatible endpoint, so it needs the
      // same headers (sans the caching beta — MiniMax doesn't honor it).
      return {
        ...baseHeaders,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "zhipu":
      return {
        ...baseHeaders,
        Authorization: `Bearer ${apiKey}`,
      };
    default:
      return baseHeaders;
  }
}

/**
 * Format messages for the conversation context
 */
export function formatConversationHistory(
  agentConfig: AgentConfig,
  conversationHistory: Message[],
  currentTopic: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Add system prompt
  messages.push({
    role: "system",
    content: agentConfig.systemPrompt,
  });

  // Add topic context
  messages.push({
    role: "user",
    content: `The current discussion topic is: "${currentTopic}"\n\nPlease engage with the other council members' perspectives while staying true to your role.`,
  });

  // Add conversation history
  for (const msg of conversationHistory) {
    if (msg.agentId === "user") {
      messages.push({
        role: "user",
        content: msg.content,
      });
    } else if (msg.agentId === agentConfig.id) {
      messages.push({
        role: "assistant",
        content: msg.content,
      });
    } else {
      // Other agents' messages are presented as user messages with attribution
      messages.push({
        role: "user",
        content: `[${msg.agentId.toUpperCase()}]: ${msg.content}`,
      });
    }
  }

  return messages;
}

export function joinBaseUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${normalized}`;
}

export function resolveEndpoint(
  baseUrl: string | undefined,
  path: string,
  fallback: string,
): string {
  if (!baseUrl) return fallback;
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (trimmed.endsWith(normalizedPath)) {
    return trimmed;
  }
  return joinBaseUrl(trimmed, normalizedPath);
}
