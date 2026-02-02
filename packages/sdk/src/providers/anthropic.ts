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
} from "./base.js";

// Models that support extended thinking
const THINKING_MODELS: AnthropicModel[] = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: "text"; text: string }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
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
    text: string;
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
  delta?: {
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicProvider implements BaseProvider {
  readonly provider = "anthropic" as const;
  readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.endpoint = API_ENDPOINTS.anthropic;
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

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: createHeaders("anthropic", this.apiKey),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const latencyMs = Date.now() - startTime;

    // Extract content from the response
    const content = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    return {
      content,
      tokens: {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
      },
      finishReason: data.stop_reason === "end_turn" ? "stop" : "length",
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

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: createHeaders("anthropic", this.apiKey),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as AnthropicStreamEvent;

          if (event.type === "content_block_delta" && event.delta?.text) {
            fullContent += event.delta.text;
            onChunk({ content: event.delta.text, done: false });
          }

          if (event.type === "message_delta" && event.usage) {
            outputTokens = event.usage.output_tokens;
          }

          if (event.type === "message_start" && event.usage) {
            inputTokens = event.usage.input_tokens;
          }
        } catch {
          // Ignore parse errors for incomplete chunks
        }
      }
    }

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    return {
      content: fullContent,
      tokens: {
        input: inputTokens,
        output: outputTokens,
      },
      finishReason: "stop",
      latencyMs,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: createHeaders("anthropic", this.apiKey),
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "Say 'ok'" }],
          max_tokens: 10,
        }),
      });
      return response.ok;
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
        content: m.content,
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

    // Add temperature (Anthropic supports 0-1 range)
    const temp = options?.temperature ?? agent.temperature ?? 1;
    request.temperature = Math.min(1, Math.max(0, temp));

    return request;
  }
}
