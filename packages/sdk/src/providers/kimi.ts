/**
 * @fileoverview Kimi (Moonshot) API provider implementation
 * Uses OpenAI-compatible format with additional use_search parameter
 */

import type { AgentConfig, KimiModel, KimiRequest } from "@socratic-council/shared";
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

export interface KimiCompletionOptions extends CompletionOptions {
  /** Enable web search for fact-checking (Kimi-specific) */
  useSearch?: boolean;
}

interface KimiUsage {
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
}

function extractReasoningTokens(usage: KimiUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return (
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.output_tokens_details?.reasoning_tokens ??
    usage.reasoning_tokens
  );
}

function estimateReasoningTokensFromThinking(thinking: string): number | undefined {
  const trimmed = thinking.trim();
  if (!trimmed) return undefined;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export class KimiProvider implements BaseProvider {
  readonly provider = "kimi" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(
      options?.baseUrl,
      "/v1/chat/completions",
      API_ENDPOINTS.kimi
    );
    this.transport = options?.transport ?? createFetchTransport();
  }

  /**
   * Build the request body for Kimi API (OpenAI-compatible + use_search)
   */
  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: KimiCompletionOptions = {},
    stream = false
  ): KimiRequest {
    const request: KimiRequest = {
      model: agent.model as KimiModel,
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      stream,
    };

    // Temperature (Kimi uses 0-1 range; K2 models require temperature=1)
    const temperature = options.temperature ?? agent.temperature ?? 0.7;
    const requiresTemperatureOne = String(agent.model).startsWith("kimi-k2");
    request.temperature = requiresTemperatureOne ? 1 : Math.max(0, Math.min(1, temperature));

    // Max tokens
    if (options.maxTokens) {
      request.max_tokens = options.maxTokens;
    } else if (agent.maxTokens) {
      request.max_tokens = agent.maxTokens;
    }

    // Kimi-specific: enable web search for fact-checking
    if (options.useSearch !== undefined) {
      request.use_search = options.useSearch;
    }

    if (stream) {
      request.stream_options = { include_usage: true };
    }

    return request;
  }

  /**
   * Generate a completion (non-streaming)
   */
  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: KimiCompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, false);

    const { status, body: responseBody } = await this.transport.request({
      url: this.endpoint,
      method: "POST",
      headers: createHeaders("kimi", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Kimi API error: ${status} - ${responseBody}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(`Kimi API returned invalid JSON: ${responseBody.slice(0, 200)}`);
    }
    const latencyMs = Date.now() - startTime;

    const choice = data.choices?.[0];
    const content = (choice?.message?.content as string) ?? "";
    const reasoning = (choice?.message?.reasoning_content as string) ?? "";
    const usage = data.usage as KimiUsage | undefined;

    return {
      content: content || reasoning,
      thinking: reasoning || undefined,
      tokens: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
        reasoning: extractReasoningTokens(usage) ?? estimateReasoningTokensFromThinking(reasoning),
      },
      finishReason: this.mapFinishReason(choice?.finish_reason as string | undefined),
      latencyMs,
    };
  }

  /**
   * Generate a streaming completion
   */
  async completeStream(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: StreamCallback,
    options: KimiCompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, true);

    let fullContent = "";
    let reasoningContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: "stop" | "length" | "error" = "stop";
    const parser = createSseParser((dataLine) => {
      const jsonStr = dataLine.trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      try {
        const data = JSON.parse(jsonStr);
        const choice = data.choices?.[0];
        const delta = choice?.delta;

        // Kimi K2.5 streams reasoning tokens via reasoning_content before
        // the actual content.  Accumulate them so we can fall back to the
        // reasoning output when the model fails to produce regular content
        // (known issue: missing </think> tag causes content to stay empty).
        if (delta?.reasoning_content) {
          const deltaThinking = String(delta.reasoning_content);
          reasoningContent += deltaThinking;
          onChunk({ content: "", thinking: deltaThinking, done: false });
        }

        if (delta?.content) {
          fullContent += delta.content;
          onChunk({ content: delta.content, done: false });
        }

        const usage = data.usage as KimiUsage | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? usage.output_tokens ?? outputTokens;
          reasoningTokens = extractReasoningTokens(usage) ?? reasoningTokens;
        }

        if (choice?.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
      } catch {
        // Skip malformed JSON lines
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("kimi", this.apiKey),
          body: JSON.stringify(body),
          timeoutMs: options.timeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          signal: options.signal,
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

    return {
      content: fullContent || reasoningContent,
      thinking: reasoningContent || undefined,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: reasoningTokens ?? estimateReasoningTokensFromThinking(reasoningContent),
      },
      finishReason,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Map Kimi finish reasons to our standard format
   */
  private mapFinishReason(reason?: string): "stop" | "length" | "error" {
    switch (reason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      default:
        return "stop";
    }
  }

  /**
   * Test the connection to Kimi API
   */
  async testConnection(): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("kimi", this.apiKey),
        body: JSON.stringify({
          model: "moonshot-v1-8k",
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
