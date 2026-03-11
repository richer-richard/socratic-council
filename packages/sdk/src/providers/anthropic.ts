/**
 * @fileoverview Anthropic Provider - Uses the Messages API v2026
 * Endpoint: https://api.anthropic.com/v1/messages
 *
 * Key differences from OpenAI:
 * - Uses 'system' as a separate top-level parameter (not in messages array)
 * - Uses 'max_tokens' (required parameter)
 * - Claude 4.5 models support 'thinking' mode for extended reasoning
 * - Requires 'anthropic-version' header
 */

import type { AgentConfig, AnthropicModel } from "@socratic-council/shared";
import { API_ENDPOINTS } from "@socratic-council/shared";
import {
  type BaseProvider,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type StreamCallback,
  createHeaders,
  resolveEndpoint,
} from "./base.js";
import { createSseParser } from "./sse.js";
import { type Transport, createFetchTransport } from "../transport.js";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
      cache_control?: { type: "ephemeral" };
    }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
      title?: string;
      cache_control?: { type: "ephemeral" };
    };

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?:
    | {
        type: "enabled";
        budget_tokens: number;
      }
    | {
        type: "adaptive";
      };
  stream?: boolean;
  metadata?: {
    user_id?: string;
  };
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    stop_reason?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  message?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

function supportsExtendedThinking(model: AnthropicModel): boolean {
  return model.includes("opus-4") || model.includes("sonnet-4") || model.includes("haiku-4");
}

function isClaudeOpus46(model: AnthropicModel): boolean {
  return model === "claude-opus-4-6";
}

function buildThinkingConfig(
  model: AnthropicModel,
  maxTokens: number
):
  | {
      type: "enabled";
      budget_tokens: number;
    }
  | {
      type: "adaptive";
    }
  | undefined {
  if (!supportsExtendedThinking(model)) return undefined;

  // Claude Opus 4.6 supports adaptive thinking mode.
  if (isClaudeOpus46(model)) {
    return { type: "adaptive" };
  }

  // Anthropic requires max_tokens > thinking.budget_tokens.
  const budgetUpperBound = Math.min(8192, maxTokens - 256);
  if (budgetUpperBound < 1024) {
    return undefined;
  }

  return {
    type: "enabled",
    budget_tokens: budgetUpperBound,
  };
}

function mapStopReason(reason?: string): "stop" | "length" | "error" {
  if (!reason || reason === "end_turn" || reason === "stop_sequence" || reason === "tool_use") {
    return "stop";
  }
  if (reason === "max_tokens") {
    return "length";
  }
  return "error";
}

export class AnthropicProvider implements BaseProvider {
  readonly provider = "anthropic" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(options?.baseUrl, "/v1/messages", API_ENDPOINTS.anthropic);
    this.transport = options?.transport ?? createFetchTransport();
  }

  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = agent.model as AnthropicModel;

    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: false,
    });

    const { status, body } = await this.transport.request({
      url: this.endpoint,
      method: "POST",
      headers: createHeaders("anthropic", this.apiKey),
      body: JSON.stringify(requestBody),
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Anthropic API error: ${status} - ${body}`);
    }

    let data: AnthropicResponse;
    try {
      data = JSON.parse(body) as AnthropicResponse;
    } catch {
      throw new Error(`Anthropic API returned invalid JSON: ${body.slice(0, 200)}`);
    }
    const latencyMs = Date.now() - startTime;

    // Extract content from the response
    const content = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const thinking = data.content
      .filter((c) => c.type === "thinking")
      .map((c) => c.thinking ?? c.text ?? "")
      .join("");

    return {
      content,
      thinking: thinking || undefined,
      tokens: {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
        reasoning: thinking ? data.usage.output_tokens : undefined,
      },
      finishReason: mapStopReason(data.stop_reason),
      latencyMs,
    };
  }

  async completeStream(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: StreamCallback,
    options?: CompletionOptions
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = agent.model as AnthropicModel;

    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: true,
    });

    let fullContent = "";
    let fullThinking = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: "stop" | "length" | "error" = "stop";
    const blockTypes = new Map<number, string>();
    const parser = createSseParser((dataLine) => {
      const data = dataLine.trim();
      if (!data || data === "[DONE]") return;
      try {
        const event = JSON.parse(data) as AnthropicStreamEvent;

        if (event.type === "content_block_start") {
          const idx = typeof event.index === "number" ? event.index : -1;
          if (idx >= 0) {
            blockTypes.set(idx, event.content_block?.type ?? "text");
          }
        }

        if (event.type === "content_block_delta" && (event.delta?.text || event.delta?.thinking)) {
          const idx = typeof event.index === "number" ? event.index : -1;
          const blockType = idx >= 0 ? blockTypes.get(idx) : undefined;
          const deltaType = event.delta.type ?? "";
          const isThinking = blockType === "thinking" || deltaType.includes("thinking");
          const thinkingDelta = event.delta.thinking ?? event.delta.text ?? "";
          const textDelta = event.delta.text ?? "";

          if (isThinking) {
            if (thinkingDelta) {
              fullThinking += thinkingDelta;
              onChunk({ content: "", thinking: thinkingDelta, done: false });
            }
          } else if (textDelta) {
            fullContent += textDelta;
            onChunk({ content: textDelta, done: false });
          }
        }

        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens;
        }
        if (event.type === "message_delta" && event.delta?.stop_reason) {
          finishReason = mapStopReason(event.delta.stop_reason);
        }

        if (event.type === "message_start") {
          // Anthropic streams input token usage in the message_start payload.
          // Depending on API version, it can appear either at the top-level `usage`
          // or nested under `message.usage`.
          const usage = event.usage ?? event.message?.usage;
          if (usage) {
            inputTokens = usage.input_tokens;
            outputTokens = usage.output_tokens ?? outputTokens;
          }
        }
      } catch {
        // Ignore parse errors for incomplete chunks
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("anthropic", this.apiKey),
          body: JSON.stringify(requestBody),
          timeoutMs: options?.timeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          signal: options?.signal,
        },
        {
          onChunk: (text) => {
            parser.push(text);
          },
          onDone: () => {
            parser.flush();
            resolve();
          },
          onError: (error) => reject(new Error(`${error.code}: ${error.message}`)),
        }
      );
    });

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: fullThinking ? outputTokens : undefined,
      },
      finishReason,
      latencyMs,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("anthropic", this.apiKey),
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          messages: [{ role: "user", content: "Say 'ok'" }],
          max_tokens: 10,
        }),
        timeoutMs: 15000,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    model: AnthropicModel,
    options?: CompletionOptions & { stream?: boolean }
  ): AnthropicRequest {
    // Extract system message
    const systemMessage = messages.find((m) => m.role === "system");
    
    // Filter and convert messages (Anthropic doesn't support system role in messages)
    const anthropicMessages: AnthropicMessage[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: this.buildMessageContent(m),
      }));

    const request: AnthropicRequest = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens ?? agent.maxTokens ?? 4096,
      stream: options?.stream ?? true,
    };

    // Add system prompt if present
    if (systemMessage) {
      request.system = systemMessage.content;
    }

    const thinking = options?.disableThinking ? undefined : buildThinkingConfig(model, request.max_tokens);
    if (thinking) {
      request.thinking = thinking;
    } else {
      // Anthropic thinking mode is not compatible with temperature overrides.
      const temp = options?.temperature ?? agent.temperature ?? 1;
      request.temperature = Math.min(1, Math.max(0, temp));
    }

    return request;
  }

  private buildMessageContent(message: ChatMessage): string | AnthropicContentBlock[] {
    const shouldCache = message.cacheControl === "ephemeral";
    if (message.role !== "user") {
      return message.content;
    }

    const content: AnthropicContentBlock[] = [];

    const pushText = (cache = false) => {
      if (!message.content.trim()) return;
      content.push({
        type: "text",
        text: message.content,
        ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      });
    };

    const pushAttachments = () => {
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind === "image") {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType,
              data: attachment.data,
            },
          });
          continue;
        }

        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: attachment.mimeType,
            data: attachment.data,
          },
          title: attachment.name,
        });
      }
    };

    if (shouldCache && (message.attachments?.length ?? 0) > 0) {
      pushAttachments();
      pushText(true);
    } else {
      pushText(shouldCache);
      pushAttachments();
    }

    return content.length > 0 ? content : message.content;
  }
}
