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
import { type Transport, createFetchTransport } from "../transport.js";

export interface KimiCompletionOptions extends CompletionOptions {
  /** Enable web search for fact-checking (Kimi-specific) */
  useSearch?: boolean;
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

    const data = JSON.parse(responseBody);
    const latencyMs = Date.now() - startTime;

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";

    return {
      content,
      tokens: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      finishReason: this.mapFinishReason(choice?.finish_reason),
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
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: "stop" | "length" | "error" = "stop";
    let buffer = "";

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
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

              const jsonStr = trimmedLine.slice(6);
              if (jsonStr === "[DONE]") continue;

              try {
                const data = JSON.parse(jsonStr);
                const choice = data.choices?.[0];
                const delta = choice?.delta;

                if (delta?.content) {
                  fullContent += delta.content;
                  onChunk({ content: delta.content, done: false });
                }

                if (data.usage) {
                  inputTokens = data.usage.prompt_tokens ?? inputTokens;
                  outputTokens = data.usage.completion_tokens ?? outputTokens;
                }

                if (choice?.finish_reason) {
                  finishReason = this.mapFinishReason(choice.finish_reason);
                }
              } catch {
                // Skip malformed JSON lines
              }
            }
          },
          onDone: () => resolve(),
          onError: (error) => reject(new Error(`${error.code}: ${error.message}`)),
        }
      );
    });

    onChunk({ content: "", done: true });

    return {
      content: fullContent,
      tokens: {
        input: inputTokens,
        output: outputTokens,
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
