/**
 * @fileoverview MiniMax API provider implementation
 * Uses MiniMax CN Anthropic-compatible endpoint:
 * https://api.minimaxi.com/anthropic/v1/messages
 */

import type { AgentConfig, MiniMaxModel, MiniMaxRequest } from "@socratic-council/shared";
import { API_ENDPOINTS } from "@socratic-council/shared";
import type {
  BaseProvider,
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  StreamCallback,
} from "./base.js";
import { createHeaders, resolveEndpoint } from "./base.js";
import { createSseParser } from "./sse.js";
import { type Transport, createFetchTransport } from "../transport.js";

interface MiniMaxUsage {
  input_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface MiniMaxContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface MiniMaxResponse {
  content?: MiniMaxContentBlock[];
  stop_reason?: string;
  usage?: MiniMaxUsage;
}

interface MiniMaxStreamEvent {
  type?: string;
  index?: number;
  content_block?: MiniMaxContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    stop_reason?: string;
  };
  usage?: MiniMaxUsage;
  message?: {
    usage?: MiniMaxUsage;
  };
}

function buildSafeThinking(maxTokens: number):
  | {
      type: "enabled";
      budget_tokens: number;
    }
  | undefined {
  // Keep budget strictly below max_tokens to avoid Anthropic-style validation failures.
  const budgetTokens = Math.min(32768, maxTokens - 256);
  if (budgetTokens < 1024) return undefined;
  return {
    type: "enabled",
    budget_tokens: budgetTokens,
  };
}

function extractReasoningTokens(usage: MiniMaxUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return (
    usage.output_tokens_details?.reasoning_tokens ??
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.reasoning_tokens
  );
}

function estimateReasoningTokensFromThinking(thinking: string): number | undefined {
  const trimmed = thinking.trim();
  if (!trimmed) return undefined;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export class MiniMaxProvider implements BaseProvider {
  readonly provider = "minimax" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(options?.baseUrl, "/v1/messages", API_ENDPOINTS.minimax);
    this.transport = options?.transport ?? createFetchTransport();
  }

  private normalizeModel(model: string): MiniMaxModel {
    if (model === "MiniMax-M2.5") return "MiniMax-M2.5";
    if (model === "minimax-m2.5") return "MiniMax-M2.5";
    return "MiniMax-M2.5";
  }

  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {},
    stream = false
  ): MiniMaxRequest {
    const systemMessage = messages.find((m) => m.role === "system");
    const maxTokens = options.maxTokens ?? agent.maxTokens ?? 4096;
    const temperature = options.temperature ?? agent.temperature ?? 1;
    const thinking = buildSafeThinking(maxTokens);

    const request: MiniMaxRequest = {
      model: this.normalizeModel(agent.model),
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      max_tokens: maxTokens,
      temperature: Math.min(1, Math.max(0, temperature)),
      stream,
    };

    if (thinking) {
      request.thinking = thinking;
    }

    if (systemMessage?.content) {
      request.system = systemMessage.content;
    }

    return request;
  }

  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, false);

    const { status, body: responseBody } = await this.transport.request({
      url: this.endpoint,
      method: "POST",
      headers: createHeaders("minimax", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`MiniMax API error: ${status} - ${responseBody}`);
    }

    let data: MiniMaxResponse;
    try {
      data = JSON.parse(responseBody) as MiniMaxResponse;
    } catch {
      throw new Error(`MiniMax API returned invalid JSON: ${responseBody.slice(0, 200)}`);
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const content = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const thinking = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? block.text ?? "")
      .join("");

    return {
      content,
      thinking: thinking || undefined,
      tokens: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
        reasoning: extractReasoningTokens(data.usage) ?? estimateReasoningTokensFromThinking(thinking),
      },
      finishReason: this.mapFinishReason(data.stop_reason),
      latencyMs: Date.now() - startTime,
    };
  }

  async completeStream(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: StreamCallback,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, true);

    let fullContent = "";
    let fullThinking = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: "stop" | "length" | "error" = "stop";
    const blockTypes = new Map<number, string>();

    const parser = createSseParser((dataLine) => {
      const jsonStr = dataLine.trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      try {
        const event = JSON.parse(jsonStr) as MiniMaxStreamEvent;

        if (event.type === "content_block_start") {
          const idx = typeof event.index === "number" ? event.index : -1;
          if (idx >= 0) {
            blockTypes.set(idx, event.content_block?.type ?? "text");
          }
        }

        if (event.type === "content_block_delta") {
          const idx = typeof event.index === "number" ? event.index : -1;
          const blockType = idx >= 0 ? blockTypes.get(idx) : undefined;
          const deltaType = event.delta?.type ?? "";
          const isThinking =
            blockType === "thinking" || deltaType.includes("thinking") || !!event.delta?.thinking;

          const deltaText = event.delta?.text ?? "";
          const deltaThinking = event.delta?.thinking ?? (isThinking ? deltaText : "");

          if (isThinking && deltaThinking) {
            fullThinking += deltaThinking;
            onChunk({ content: "", thinking: deltaThinking, done: false });
          } else if (deltaText) {
            fullContent += deltaText;
            onChunk({ content: deltaText, done: false });
          }

          if (event.delta?.stop_reason) {
            finishReason = this.mapFinishReason(event.delta.stop_reason);
          }
        }

        if (event.type === "message_start") {
          const usage = event.usage ?? event.message?.usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? inputTokens;
            outputTokens = usage.output_tokens ?? usage.completion_tokens ?? outputTokens;
            reasoningTokens = extractReasoningTokens(usage) ?? reasoningTokens;
          }
        }

        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens ?? event.usage.completion_tokens ?? outputTokens;
          reasoningTokens = extractReasoningTokens(event.usage) ?? reasoningTokens;
        }

        if (event.type === "message_stop" && event.usage) {
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? event.usage.completion_tokens ?? outputTokens;
          reasoningTokens = extractReasoningTokens(event.usage) ?? reasoningTokens;
        }
      } catch {
        // Ignore malformed chunks.
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("minimax", this.apiKey),
          body: JSON.stringify(body),
          timeoutMs: options.timeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          signal: options.signal,
        },
        {
          onChunk: (text) => parser.push(text),
          onDone: () => {
            parser.flush();
            resolve();
          },
          onError: (error) => reject(new Error(`${error.code}: ${error.message}`)),
        }
      );
    });

    onChunk({ content: "", done: true });

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: reasoningTokens ?? estimateReasoningTokensFromThinking(fullThinking),
      },
      finishReason,
      latencyMs: Date.now() - startTime,
    };
  }

  private mapFinishReason(reason?: string): "stop" | "length" | "error" {
    switch (reason) {
      case "max_tokens":
      case "length":
        return "length";
      case "stop":
      case "end_turn":
      case "tool_use":
        return "stop";
      default:
        return "stop";
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("minimax", this.apiKey),
        body: JSON.stringify({
          model: "MiniMax-M2.5",
          messages: [{ role: "user", content: "Say 'ok'" }],
          max_tokens: 16,
          stream: false,
        }),
        timeoutMs: 15000,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }
}
