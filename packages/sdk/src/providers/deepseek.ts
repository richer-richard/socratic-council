/**
 * @fileoverview DeepSeek API provider implementation
 * Uses OpenAI-compatible format with /v1/chat/completions endpoint
 */

import type { AgentConfig, DeepSeekModel, DeepSeekRequest } from "@socratic-council/shared";
import { API_ENDPOINTS } from "@socratic-council/shared";
import type {
  BaseProvider,
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  StreamCallback,
} from "./base.js";
import { createHeaders } from "./base.js";

export class DeepSeekProvider implements BaseProvider {
  readonly provider = "deepseek" as const;
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Build the request body for DeepSeek API (OpenAI-compatible format)
   */
  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {},
    stream = false
  ): DeepSeekRequest {
    const request: DeepSeekRequest = {
      model: agent.model as DeepSeekModel,
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      stream,
    };

    // Temperature (DeepSeek supports 0-2)
    const temperature = options.temperature ?? agent.temperature ?? 1;
    request.temperature = Math.max(0, Math.min(2, temperature));

    // Max tokens
    if (options.maxTokens) {
      request.max_tokens = options.maxTokens;
    } else if (agent.maxTokens) {
      request.max_tokens = agent.maxTokens;
    }

    return request;
  }

  /**
   * Generate a completion (non-streaming)
   */
  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, false);

    const response = await fetch(API_ENDPOINTS.deepseek, {
      method: "POST",
      headers: createHeaders("deepseek", this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const latencyMs = Date.now() - startTime;

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    
    // DeepSeek V3.2 includes reasoning_content for deepseek-reasoner model
    const reasoningContent = choice?.message?.reasoning_content;

    return {
      content,
      tokens: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        reasoning: reasoningContent ? data.usage?.completion_tokens_details?.reasoning_tokens : undefined,
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
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, true);

    const response = await fetch(API_ENDPOINTS.deepseek, {
      method: "POST",
      headers: createHeaders("deepseek", this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming");
    }

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
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

            // DeepSeek may stream reasoning_content separately
            if (delta?.reasoning_content) {
              // We can optionally handle reasoning content
              // For now, we track it but don't output it to the main stream
            }

            // Update token counts if available (usually only in final chunk)
            if (data.usage) {
              inputTokens = data.usage.prompt_tokens ?? inputTokens;
              outputTokens = data.usage.completion_tokens ?? outputTokens;
              if (data.usage.completion_tokens_details?.reasoning_tokens) {
                reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens;
              }
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
        reasoning: reasoningTokens,
      },
      finishReason,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Map DeepSeek finish reasons to our standard format
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
   * Test the connection to DeepSeek API
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(API_ENDPOINTS.deepseek, {
        method: "POST",
        headers: createHeaders("deepseek", this.apiKey),
        body: JSON.stringify({
          model: "deepseek-chat",
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
