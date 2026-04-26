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
  resolveEndpoint,
} from "./base.js";
import { createSseParser } from "./sse.js";
import { type Transport, createFetchTransport } from "../transport.js";

// Models that support reasoning.effort parameter
const REASONING_MODELS: OpenAIModel[] = [
  "o1",
  "o3",
  "o4-mini",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-pro",
  "gpt-5.2",
  "gpt-5-mini",
  "gpt-5-nano",
];

// Models that DON'T support temperature (reasoning models use reasoning.effort instead)
const NO_TEMPERATURE_MODELS: OpenAIModel[] = [
  "o1",
  "o3",
  "o4-mini",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-pro",
  "gpt-5.2",
  "gpt-5-mini",
  "gpt-5-nano",
];

interface OpenAIResponsesRequest {
  model: string;
  input: string | OpenAIInputMessage[];
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  prompt_cache_key?: string;
  prompt_cache_retention?: "in_memory" | "24h";
  top_p?: number;
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    summary?: "auto" | "concise" | "detailed";
  };
  stream?: boolean;
}

type OpenAIInputContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail?: "auto";
    }
  | {
      type: "input_file";
      filename: string;
      file_data: string;
    };

interface OpenAIInputMessage {
  role: string;
  content: string | OpenAIInputContent[];
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
  reasoning?: string;
  part?: {
    type?: string;
    text?: string;
  };
  summary?: {
    text?: string;
  };
  response?: {
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
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
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  item?: {
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

function isOutputTextType(type: string | undefined): boolean {
  return type === "output_text" || type === "text";
}

function collectContentText(
  content:
    | Array<{
        type?: string;
        text?: string;
      }>
    | undefined,
): string {
  return (
    content
      ?.filter((part) => isOutputTextType(part.type))
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("") ?? ""
  );
}

function extractOutputText(data: OpenAIResponsesResponse): string {
  const outputText = data.output?.map((item) => collectContentText(item.content)).join("") ?? "";

  if (outputText) return outputText;

  // Fallback for SDK-style response helpers
  const fallback = (data as { output_text?: string }).output_text;
  return fallback ?? "";
}

function extractOutputThinking(data: OpenAIResponsesResponse): string {
  const chunks =
    data.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => {
        const type = (content as { type?: string }).type ?? "";
        return type.includes("reasoning") || type.includes("summary");
      })
      .map((content) => (content as { text?: string }).text ?? "")
      .filter(Boolean) ?? [];
  return chunks.join("");
}

function reasoningEffortForModel(model: OpenAIModel): "high" | "xhigh" {
  if (
    model === "gpt-5.5" ||
    model === "gpt-5.4" ||
    model === "gpt-5.3-codex" ||
    model === "gpt-5.2" ||
    model === "gpt-5.2-pro"
  ) {
    return "xhigh";
  }
  return "high";
}

function extractReasoningChunk(event: OpenAIStreamEvent): string {
  if (typeof event.reasoning === "string" && event.reasoning.length > 0) {
    return event.reasoning;
  }

  const type = event.type ?? "";
  if (!type.includes("reasoning") && !type.includes("summary")) return "";

  if (typeof event.delta === "string" && event.delta.length > 0) {
    return event.delta;
  }
  if (typeof event.text === "string" && event.text.length > 0) {
    return event.text;
  }
  if (typeof event.part?.text === "string" && event.part.text.length > 0) {
    return event.part.text;
  }
  if (typeof event.summary?.text === "string" && event.summary.text.length > 0) {
    return event.summary.text;
  }

  return "";
}

function mergeFallbackOutput(current: string, next: string): { content: string; delta: string } {
  if (!next) {
    return { content: current, delta: "" };
  }

  if (!current) {
    return { content: next, delta: next };
  }

  if (next === current) {
    return { content: current, delta: "" };
  }

  if (next.startsWith(current)) {
    return { content: next, delta: next.slice(current.length) };
  }

  if (current.endsWith(next) || current.includes(next)) {
    return { content: current, delta: "" };
  }

  return { content: `${current}${next}`, delta: next };
}

function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export class OpenAIProvider implements BaseProvider {
  readonly provider = "openai" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(options?.baseUrl, "/v1/responses", API_ENDPOINTS.openai);
    this.transport = options?.transport ?? createFetchTransport();
  }

  async complete(
    agent: AgentConfig,
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = agent.model as OpenAIModel;

    // Build the request body based on model capabilities
    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: false,
    });

    const { status, body } = await this.transport.request({
      url: this.endpoint,
      method: "POST",
      headers: createHeaders("openai", this.apiKey),
      body: JSON.stringify(requestBody),
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`OpenAI API error: ${status} - ${body}`);
    }

    let data: OpenAIResponsesResponse;
    try {
      data = JSON.parse(body) as OpenAIResponsesResponse;
    } catch {
      throw new Error(`OpenAI API returned invalid JSON: ${body.slice(0, 200)}`);
    }
    const latencyMs = Date.now() - startTime;

    // Extract content from the response
    const content = extractOutputText(data);
    const thinking = extractOutputThinking(data);

    return {
      content,
      thinking: thinking || undefined,
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
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = agent.model as OpenAIModel;

    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: true,
    });

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let fullThinking = "";
    let sawDelta = false;

    const appendFallbackText = (text: string) => {
      if (!text || sawDelta) return;
      const merged = mergeFallbackOutput(fullContent, text);
      fullContent = merged.content;
      if (merged.delta) {
        onChunk({ content: merged.delta, done: false });
      }
    };

    const parser = createSseParser((data) => {
      if (!data || data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data) as OpenAIStreamEvent;

        if (parsed.type === "response.output_text.delta" && parsed.delta) {
          sawDelta = true;
          fullContent += parsed.delta;
          onChunk({ content: parsed.delta, done: false });
          return;
        }

        if (parsed.type === "response.output_text.done" && parsed.text && !sawDelta) {
          appendFallbackText(parsed.text);
          return;
        }

        if (parsed.type === "response.output_item.done") {
          appendFallbackText(collectContentText(parsed.item?.content));
          return;
        }

        if (
          parsed.type === "response.content_part.done" &&
          isOutputTextType(parsed.part?.type) &&
          parsed.part?.text
        ) {
          appendFallbackText(parsed.part.text);
          return;
        }

        const reasoningChunk = extractReasoningChunk(parsed);
        if (reasoningChunk) {
          fullThinking += reasoningChunk;
          onChunk({ content: "", thinking: reasoningChunk, done: false });
          return;
        }

        if (parsed.type === "response.completed") {
          if (parsed.response?.usage) {
            inputTokens = parsed.response.usage.input_tokens ?? inputTokens;
            outputTokens = parsed.response.usage.output_tokens ?? outputTokens;
            reasoningTokens =
              parsed.response.usage.output_tokens_details?.reasoning_tokens ??
              parsed.response.usage.reasoning_tokens ??
              reasoningTokens;
          }

          const completedText =
            parsed.response?.output?.map((item) => collectContentText(item.content)).join("") ?? "";
          appendFallbackText(completedText);
          return;
        }

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
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("openai", this.apiKey),
          body: JSON.stringify(requestBody),
          timeoutMs: options?.timeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          signal: options?.signal,
        },
        {
          onChunk: (text) => {
            parser.push(text);
          },
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
    const latencyMs = Date.now() - startTime;

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: reasoningTokens || undefined,
      },
      finishReason: "stop",
      latencyMs,
    };
  }

  async testConnection(model?: string): Promise<boolean> {
    try {
      // Use a simple test with gpt-5-nano (cheapest model)
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("openai", this.apiKey),
        body: JSON.stringify({
          model: model ?? "gpt-5-nano",
          input: "Say 'ok'",
          max_output_tokens: 10,
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
    model: OpenAIModel,
    options?: CompletionOptions & { stream?: boolean },
  ): OpenAIResponsesRequest {
    // Extract system message for instructions
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    // Build input array in the format OpenAI expects
    const input = nonSystemMessages.map((m) => ({
      role: m.role,
      content: this.buildMessageContent(m),
    }));

    const request: OpenAIResponsesRequest = {
      model,
      input:
        input.length === 1 && input[0]?.role === "user" && typeof input[0].content === "string"
          ? input[0].content
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
      request.reasoning = { effort: reasoningEffortForModel(model), summary: "auto" };
    }

    const promptCacheKey = this.buildPromptCacheKey(messages);
    if (promptCacheKey) {
      request.prompt_cache_key = promptCacheKey;
      request.prompt_cache_retention = "in_memory";
    }

    return request;
  }

  private buildPromptCacheKey(messages: ChatMessage[]): string | undefined {
    const boundary = messages.findLastIndex((message) => message.cacheControl === "ephemeral");
    if (boundary < 0) {
      return undefined;
    }

    const prefix = messages
      .slice(0, boundary + 1)
      .map((message) =>
        [
          message.role,
          message.content,
          message.attachments
            ?.map(
              (attachment) =>
                `${attachment.id}:${attachment.kind}:${attachment.name}:${attachment.data.length}`,
            )
            .join("|") ?? "",
        ].join("::"),
      )
      .join("\n---\n");

    return `sc-prefix-${stableHash(prefix)}`;
  }

  private buildMessageContent(message: ChatMessage): string | OpenAIInputContent[] {
    if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
      return message.content;
    }

    const content: OpenAIInputContent[] = [];
    if (message.content.trim()) {
      content.push({ type: "input_text", text: message.content });
    }

    for (const attachment of message.attachments) {
      if (attachment.kind === "image") {
        content.push({
          type: "input_image",
          image_url: toDataUrl(attachment.mimeType, attachment.data),
          detail: "auto",
        });
        continue;
      }

      content.push({
        type: "input_file",
        filename: attachment.name,
        file_data: toDataUrl(attachment.mimeType, attachment.data),
      });
    }

    return content.length > 0 ? content : message.content;
  }
}
