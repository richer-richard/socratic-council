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
import { type Transport, createFetchTransport } from "../transport.js";

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
  message?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
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

    const data = JSON.parse(body) as AnthropicResponse;
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

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = "";

    const processLine = (line: string) => {
      if (!line.startsWith("data: ")) return;
      const data = line.slice(6);
      if (!data || data === "[DONE]") return;

      try {
        const event = JSON.parse(data) as AnthropicStreamEvent;

        if (event.type === "content_block_delta" && event.delta?.text) {
          fullContent += event.delta.text;
          onChunk({ content: event.delta.text, done: false });
        }

        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens;
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
    };

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
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              processLine(line);
            }
          },
          onDone: () => {
            // Flush any buffered line that didn't end with a newline.
            const trailing = buffer.trim();
            if (trailing) {
              processLine(trailing);
            }
            buffer = "";
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
