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
import { createHeaders, resolveEndpoint } from "./base.js";
import { type Transport, createFetchTransport } from "../transport.js";

export class DeepSeekProvider implements BaseProvider {
  readonly provider = "deepseek" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(
      options?.baseUrl,
      "/v1/chat/completions",
      API_ENDPOINTS.deepseek
    );
    this.transport = options?.transport ?? createFetchTransport();
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

    const { status, body: responseBody } = await this.transport.request({
      url: this.endpoint,
      method: "POST",
      headers: createHeaders("deepseek", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`DeepSeek API error: ${status} - ${responseBody}`);
    }

    const data = JSON.parse(responseBody);
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

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: "stop" | "length" | "error" = "stop";
    let buffer = "";

    const processLine = (line: string) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || !trimmedLine.startsWith("data: ")) return;

      const jsonStr = trimmedLine.slice(6);
      if (!jsonStr || jsonStr === "[DONE]") return;

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
          if (data.usage.completion_tokens_details?.reasoning_tokens) {
            reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens;
          }
        }

        if (choice?.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
      } catch {
        // Skip malformed JSON lines
      }
    };

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("deepseek", this.apiKey),
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
              processLine(line);
            }
          },
          onDone: () => {
            if (buffer.trim()) {
              processLine(buffer);
            }
            buffer = "";
            resolve();
          },
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
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("deepseek", this.apiKey),
        body: JSON.stringify({
          model: "deepseek-chat",
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
