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
import { createHeaders } from "./base.js";

export interface KimiCompletionOptions extends CompletionOptions {
  /** Enable web search for fact-checking (Kimi-specific) */
  useSearch?: boolean;
}

export class KimiProvider implements BaseProvider {
  readonly provider = "kimi" as const;
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
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

    // Temperature (Kimi uses 0-1 range)
    const temperature = options.temperature ?? agent.temperature ?? 0.7;
    request.temperature = Math.max(0, Math.min(1, temperature));

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

    const response = await fetch(API_ENDPOINTS.kimi, {
      method: "POST",
      headers: createHeaders("kimi", this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
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

    const response = await fetch(API_ENDPOINTS.kimi, {
      method: "POST",
      headers: createHeaders("kimi", this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: "stop" | "length" | "error" = "stop";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
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

            // Update token counts if available (usually only in final chunk)
            if (data.usage) {
              inputTokens = data.usage.prompt_tokens ?? inputTokens;
              outputTokens = data.usage.completion_tokens ?? outputTokens;
            }

            // Check finish reason
            if (choice?.finish_reason) {
              finishReason = this.mapFinishReason(choice.finish_reason);
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

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
      const response = await fetch(API_ENDPOINTS.kimi, {
        method: "POST",
        headers: createHeaders("kimi", this.apiKey),
        body: JSON.stringify({
          model: "moonshot-v1-8k",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10,
        }),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
