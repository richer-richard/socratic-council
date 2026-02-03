/**
 * @fileoverview OpenAI Provider - Uses the Responses API (2026)
 * Endpoint: https://api.openai.com/v1/responses
 *
 * IMPORTANT: The Responses API has a different format than Chat Completions!
 * - Uses 'input' instead of 'messages'
 * - Uses 'instructions' for system prompt
 * - Uses 'max_output_tokens' instead of 'max_tokens'
 * - Reasoning models (o1, o3, o4-mini) use 'reasoning.effort' parameter
 */

import type { AgentConfig, OpenAIModel } from "@socratic-council/shared";
import { API_ENDPOINTS } from "@socratic-council/shared";
import {
  type BaseProvider,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type StreamCallback,
  createHeaders,
} from "./base.js";

// Models that support reasoning.effort parameter
const REASONING_MODELS: OpenAIModel[] = ["o1", "o3", "o4-mini", "gpt-5.2-pro"];

// Models that DON'T support temperature (reasoning models use reasoning.effort instead)
const NO_TEMPERATURE_MODELS: OpenAIModel[] = ["o1", "o3", "o4-mini"];

interface OpenAIResponsesRequest {
  model: string;
  input: string | Array<{ role: string; content: string }>;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  reasoning?: {
    effort?: "low" | "medium" | "high";
  };
  stream?: boolean;
}

interface OpenAIResponsesResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  output: Array<{
    type: string;
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    reasoning_tokens?: number;
  };
}

interface OpenAIStreamEvent {
  type: string;
  delta?: string;
  text?: string;
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      output_tokens_details?: {
        reasoning_tokens?: number;
      };
      reasoning_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    reasoning_tokens?: number;
  };
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

function extractOutputText(data: OpenAIResponsesResponse): string {
  const outputText =
    data.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text" || content.type === "text")
      .map((content) => content.text)
      .filter(Boolean)
      .join("") ?? "";

  if (outputText) return outputText;

  // Fallback for SDK-style response helpers
  const fallback = (data as { output_text?: string }).output_text;
  return fallback ?? "";
}

export class OpenAIProvider implements BaseProvider {
  readonly provider = "openai" as const;
  readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.endpoint = API_ENDPOINTS.openai;
  }

  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = agent.model as OpenAIModel;

    // Build the request body based on model capabilities
    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: false,
    });

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: createHeaders("openai", this.apiKey),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as OpenAIResponsesResponse;
    const latencyMs = Date.now() - startTime;

    // Extract content from the response
    const content = extractOutputText(data);

    return {
      content,
      tokens: {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
        reasoning:
          data.usage.output_tokens_details?.reasoning_tokens ?? data.usage.reasoning_tokens,
      },
      finishReason: "stop",
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
    const model = agent.model as OpenAIModel;

    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: true,
    });

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: createHeaders("openai", this.apiKey),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let sawDelta = false;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6); // Remove "data: " prefix
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as OpenAIStreamEvent;

          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            sawDelta = true;
            fullContent += parsed.delta;
            onChunk({ content: parsed.delta, done: false });
            continue;
          }

          if (parsed.type === "response.output_text.done" && parsed.text && !sawDelta) {
            fullContent += parsed.text;
            onChunk({ content: parsed.text, done: false });
            continue;
          }

          if (parsed.type === "response.completed" && parsed.response?.usage) {
            inputTokens = parsed.response.usage.input_tokens ?? inputTokens;
            outputTokens = parsed.response.usage.output_tokens ?? outputTokens;
            reasoningTokens =
              parsed.response.usage.output_tokens_details?.reasoning_tokens ??
              parsed.response.usage.reasoning_tokens ??
              reasoningTokens;
            continue;
          }

          // Fallbacks for legacy formats
          const legacyContent =
            parsed.output?.[0]?.content?.[0]?.text ??
            (parsed as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta
              ?.content ??
            "";

          if (legacyContent) {
            fullContent += legacyContent;
            onChunk({ content: legacyContent, done: false });
          }

          if (parsed.usage) {
            inputTokens = parsed.usage.input_tokens ?? inputTokens;
            outputTokens = parsed.usage.output_tokens ?? outputTokens;
            reasoningTokens =
              parsed.usage.output_tokens_details?.reasoning_tokens ??
              parsed.usage.reasoning_tokens ??
              reasoningTokens;
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
        reasoning: reasoningTokens || undefined,
      },
      finishReason: "stop",
      latencyMs,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      // Use a simple test with gpt-5-nano (cheapest model)
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: createHeaders("openai", this.apiKey),
        body: JSON.stringify({
          model: "gpt-5-nano",
          input: "Say 'ok'",
          max_output_tokens: 10,
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
    model: OpenAIModel,
    options?: CompletionOptions & { stream?: boolean }
  ): OpenAIResponsesRequest {
    // Extract system message for instructions
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    // Build input array in the format OpenAI expects
    const input = nonSystemMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const request: OpenAIResponsesRequest = {
      model,
      input: input.length === 1 && input[0]?.role === "user" 
        ? input[0].content  // Single user message can be a string
        : input,
      stream: options?.stream ?? true,
    };

    // Add system instructions if present
    if (systemMessage) {
      request.instructions = systemMessage.content;
    }

    // Handle temperature - reasoning models don't support it
    if (!NO_TEMPERATURE_MODELS.includes(model)) {
      request.temperature = options?.temperature ?? agent.temperature ?? 1;
    }

    // Handle max tokens
    if (options?.maxTokens ?? agent.maxTokens) {
      request.max_output_tokens = options?.maxTokens ?? agent.maxTokens;
    }

    // Handle reasoning effort for reasoning models
    if (REASONING_MODELS.includes(model)) {
      request.reasoning = { effort: "medium" };
    }

    return request;
  }
}
