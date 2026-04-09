/**
 * @fileoverview Qwen API provider implementation
 * Uses OpenAI-compatible format via Alibaba Cloud DashScope compatible-mode endpoint.
 */

import type { AgentConfig, QwenModel, QwenRequest } from "@socratic-council/shared";
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

type StreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
};

function estimateReasoningTokensFromThinking(thinking: string): number | undefined {
  const trimmed = thinking.trim();
  if (!trimmed) return undefined;
  // Rough token estimate fallback used only when provider omits reasoning usage.
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function extractReasoningTokens(usage: StreamUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return (
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.output_tokens_details?.reasoning_tokens ??
    usage.reasoning_tokens
  );
}

export class QwenProvider implements BaseProvider {
  readonly provider = "qwen" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(options?.baseUrl, "/chat/completions", API_ENDPOINTS.qwen);
    this.transport = options?.transport ?? createFetchTransport();
  }

  private normalizeModel(model: string): QwenModel {
    if (model === "qwen3.6-plus") return "qwen3.6-plus";
    if (model === "qwen3.5-plus") return "qwen3.5-plus";
    return "qwen3.6-plus";
  }

  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {},
    stream = false,
  ): QwenRequest {
    const request: QwenRequest = {
      model: this.normalizeModel(agent.model),
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      // Explicitly enable reasoning output for Qwen 3.5 Plus.
      enable_thinking: true,
      stream,
    };

    const temperature = options.temperature ?? agent.temperature ?? 1;
    request.temperature = Math.max(0, Math.min(2, temperature));

    if (options.maxTokens) {
      request.max_tokens = options.maxTokens;
    } else if (agent.maxTokens) {
      request.max_tokens = agent.maxTokens;
    }

    if (stream) {
      request.stream_options = { include_usage: true };
    }

    return request;
  }

  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, false);

    const { status, body: responseBody } = await this.transport.request({
      url: this.endpoint,
      method: "POST",
      headers: createHeaders("qwen", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Qwen API error: ${status} - ${responseBody}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(`Qwen API returned invalid JSON: ${responseBody.slice(0, 200)}`);
    }

    const choice = data.choices?.[0];
    const content = (choice?.message?.content as string) ?? "";
    const thinking = (choice?.message?.reasoning_content as string) ?? "";

    return {
      content,
      thinking: thinking || undefined,
      tokens: {
        input: (data.usage?.prompt_tokens as number) ?? 0,
        output:
          (data.usage?.completion_tokens as number) ?? (data.usage?.output_tokens as number) ?? 0,
        reasoning:
          (extractReasoningTokens(data.usage as StreamUsage | undefined) as number | undefined) ??
          estimateReasoningTokensFromThinking(thinking),
      },
      finishReason: this.mapFinishReason(choice?.finish_reason as string | undefined),
      latencyMs: Date.now() - startTime,
    };
  }

  async completeStream(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: StreamCallback,
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, true);

    let fullContent = "";
    let fullThinking = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: "stop" | "length" | "error" = "stop";

    const parser = createSseParser((dataLine) => {
      const jsonStr = dataLine.trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = JSON.parse(jsonStr);
        const choice = data.choices?.[0];
        const delta = choice?.delta;

        if (delta?.reasoning_content) {
          const deltaThinking = String(delta.reasoning_content);
          fullThinking += deltaThinking;
          onChunk({ content: "", thinking: deltaThinking, done: false });
        }

        if (delta?.content) {
          const deltaContent = String(delta.content);
          fullContent += deltaContent;
          onChunk({ content: deltaContent, done: false });
        }

        const usage = data.usage as StreamUsage | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? usage.output_tokens ?? outputTokens;
          reasoningTokens = extractReasoningTokens(usage) ?? reasoningTokens;
        }

        if (choice?.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
      } catch {
        // Skip malformed lines
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("qwen", this.apiKey),
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
        },
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
      case "stop":
      case "tool_calls":
        return "stop";
      case "length":
        return "length";
      default:
        return "stop";
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("qwen", this.apiKey),
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10,
        }),
        timeoutMs: 15000,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }
}
