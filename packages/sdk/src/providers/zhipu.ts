/**
 * @fileoverview Zhipu (Z.AI) API provider implementation
 * Uses OpenAI-compatible format via bigmodel.cn endpoint.
 */

import type { AgentConfig, ZhipuModel, ZhipuRequest } from "@socratic-council/shared";
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
};

function extractReasoningTokens(usage: StreamUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
}

export class ZhipuProvider implements BaseProvider {
  readonly provider = "zhipu" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(options?.baseUrl, "/chat/completions", API_ENDPOINTS.zhipu);
    this.transport = options?.transport ?? createFetchTransport();
  }

  private normalizeModel(model: string): ZhipuModel {
    if (model === "glm-5.1" || model === "glm-5" || model === "glm-4.7") return model;
    return "glm-5.1";
  }

  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {},
    stream = false,
  ): ZhipuRequest {
    const request: ZhipuRequest = {
      model: this.normalizeModel(agent.model),
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      stream,
    };

    const temperature = options.temperature ?? agent.temperature ?? 0.7;
    // Fix 6.3: GLM accepts temperature up to 2; the previous Math.min(1) clamp
    // silently capped users' configured higher-temperature setups.
    request.temperature = Math.max(0, Math.min(2, temperature));

    if (options.maxTokens) {
      request.max_tokens = options.maxTokens;
    } else if (agent.maxTokens) {
      request.max_tokens = agent.maxTokens;
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
      headers: createHeaders("zhipu", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Zhipu API error: ${status} - ${responseBody}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(`Zhipu API returned invalid JSON: ${responseBody.slice(0, 200)}`);
    }

    const choice = data.choices?.[0];
    const content = (choice?.message?.content as string) ?? "";
    const thinking = (choice?.message?.reasoning_content as string) ?? "";

    return {
      content,
      thinking: thinking || undefined,
      tokens: {
        input: (data.usage?.prompt_tokens as number) ?? 0,
        output: (data.usage?.completion_tokens as number) ?? 0,
        reasoning: extractReasoningTokens(data.usage as StreamUsage | undefined),
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
          headers: createHeaders("zhipu", this.apiKey),
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
          // Fix 6.1: forward the typed TransportFailure so api.ts can
          // classify abort/timeout via .code (see fix 4.1).
          onError: (error) => reject(error),
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
        reasoning: reasoningTokens,
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

  async testConnection(model?: string): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("zhipu", this.apiKey),
        body: JSON.stringify({
          model: model ?? "glm-5.1",
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
