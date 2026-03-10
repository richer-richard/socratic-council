/**
 * @fileoverview MiniMax API provider implementation
 * Uses MiniMax CN Anthropic-compatible endpoint:
 * https://api.minimaxi.com/anthropic/v1/messages
 */

import type { AgentConfig, MiniMaxModel, MiniMaxRequest } from "@socratic-council/shared";
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

interface MiniMaxUsage {
  input_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface MiniMaxContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface MiniMaxResponse {
  content?: MiniMaxContentBlock[];
  stop_reason?: string;
  usage?: MiniMaxUsage;
}

interface MiniMaxStreamEvent {
  type?: string;
  index?: number;
  content_block?: MiniMaxContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    stop_reason?: string;
  };
  usage?: MiniMaxUsage;
  message?: {
    usage?: MiniMaxUsage;
  };
}

const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";

function buildSafeThinking(maxTokens: number):
  | {
      type: "enabled";
      budget_tokens: number;
    }
  | undefined {
  // Keep budget strictly below max_tokens to avoid Anthropic-style validation failures.
  const budgetTokens = Math.min(32768, maxTokens - 256);
  if (budgetTokens < 1024) return undefined;
  return {
    type: "enabled",
    budget_tokens: budgetTokens,
  };
}

function extractReasoningTokens(usage: MiniMaxUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return (
    usage.output_tokens_details?.reasoning_tokens ??
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.reasoning_tokens
  );
}

function estimateReasoningTokensFromThinking(thinking: string): number | undefined {
  const trimmed = thinking.trim();
  if (!trimmed) return undefined;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function estimateMessageTokens(messages: ChatMessage[], system?: string): number {
  const chars =
    messages.reduce((sum, message) => sum + message.content.length + 16, 0) +
    (system?.length ?? 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateOutputTokens(content: string, thinking: string): number {
  return Math.max(1, Math.ceil((content.length + Math.min(thinking.length, 8000)) / 4));
}

function partialTagSuffixLength(input: string): number {
  const max = Math.min(input.length, THINK_CLOSE_TAG.length - 1);
  for (let length = max; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (THINK_OPEN_TAG.startsWith(suffix) || THINK_CLOSE_TAG.startsWith(suffix)) {
      return length;
    }
  }
  return 0;
}

function createThinkTagStreamParser() {
  let insideThink = false;
  let carry = "";

  const parseChunk = (chunk: string) => {
    let content = "";
    let thinking = "";
    let index = 0;

    while (index < chunk.length) {
      if (chunk.startsWith(THINK_OPEN_TAG, index)) {
        insideThink = true;
        index += THINK_OPEN_TAG.length;
        continue;
      }
      if (chunk.startsWith(THINK_CLOSE_TAG, index)) {
        insideThink = false;
        index += THINK_CLOSE_TAG.length;
        continue;
      }

      if (insideThink) {
        thinking += chunk[index];
      } else {
        content += chunk[index];
      }
      index += 1;
    }

    return { content, thinking };
  };

  return {
    push(chunk: string) {
      const combined = carry + chunk;
      const carryLength = partialTagSuffixLength(combined);
      const processable = carryLength > 0 ? combined.slice(0, -carryLength) : combined;
      carry = carryLength > 0 ? combined.slice(-carryLength) : "";
      return parseChunk(processable);
    },
    flush() {
      const trailing = carry;
      carry = "";
      return parseChunk(trailing);
    },
  };
}

function splitThinkTaggedText(input: string): { content: string; thinking: string } {
  const parser = createThinkTagStreamParser();
  const first = parser.push(input);
  const final = parser.flush();
  return {
    content: `${first.content}${final.content}`,
    thinking: `${first.thinking}${final.thinking}`,
  };
}

export class MiniMaxProvider implements BaseProvider {
  readonly provider = "minimax" as const;
  readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(options?.baseUrl, "/v1/messages", API_ENDPOINTS.minimax);
    this.transport = options?.transport ?? createFetchTransport();
  }

  private normalizeModel(model: string): MiniMaxModel {
    if (model === "MiniMax-M2.5") return "MiniMax-M2.5";
    if (model === "minimax-m2.5") return "MiniMax-M2.5";
    return "MiniMax-M2.5";
  }

  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {},
    stream = false
  ): MiniMaxRequest {
    const systemMessage = messages.find((m) => m.role === "system");
    const maxTokens = options.maxTokens ?? agent.maxTokens ?? 4096;
    const temperature = options.temperature ?? agent.temperature ?? 1;
    const thinking = buildSafeThinking(maxTokens);

    const request: MiniMaxRequest = {
      model: this.normalizeModel(agent.model),
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      max_tokens: maxTokens,
      temperature: Math.min(1, Math.max(0, temperature)),
      stream,
    };

    if (thinking) {
      request.thinking = thinking;
    }

    if (systemMessage?.content) {
      request.system = systemMessage.content;
    }

    return request;
  }

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
      headers: createHeaders("minimax", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`MiniMax API error: ${status} - ${responseBody}`);
    }

    let data: MiniMaxResponse;
    try {
      data = JSON.parse(responseBody) as MiniMaxResponse;
    } catch {
      throw new Error(`MiniMax API returned invalid JSON: ${responseBody.slice(0, 200)}`);
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const rawContent = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const explicitThinking = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? block.text ?? "")
      .join("");
    const tagged = splitThinkTaggedText(rawContent);
    const content = tagged.content;
    const thinking = `${explicitThinking}${tagged.thinking}`;

    return {
      content,
      thinking: thinking || undefined,
      tokens: {
        input: data.usage?.input_tokens ?? estimateMessageTokens(messages, body.system),
        output:
          data.usage?.output_tokens ??
          data.usage?.completion_tokens ??
          estimateOutputTokens(content, thinking),
        reasoning: extractReasoningTokens(data.usage) ?? estimateReasoningTokensFromThinking(thinking),
      },
      finishReason: this.mapFinishReason(data.stop_reason),
      latencyMs: Date.now() - startTime,
    };
  }

  async completeStream(
    agent: AgentConfig,
    messages: ChatMessage[],
    onChunk: StreamCallback,
    options: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const body = this.buildRequestBody(agent, messages, options, true);

    let fullContent = "";
    let fullThinking = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: "stop" | "length" | "error" = "stop";
    const blockTypes = new Map<number, string>();
    const taggedTextParser = createThinkTagStreamParser();

    const parser = createSseParser((dataLine) => {
      const jsonStr = dataLine.trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      try {
        const event = JSON.parse(jsonStr) as MiniMaxStreamEvent;

        if (event.type === "content_block_start") {
          const idx = typeof event.index === "number" ? event.index : -1;
          if (idx >= 0) {
            blockTypes.set(idx, event.content_block?.type ?? "text");
          }
        }

        if (event.type === "content_block_delta") {
          const idx = typeof event.index === "number" ? event.index : -1;
          const blockType = idx >= 0 ? blockTypes.get(idx) : undefined;
          const deltaType = event.delta?.type ?? "";
          const isThinking =
            blockType === "thinking" || deltaType.includes("thinking") || !!event.delta?.thinking;

          const deltaText = event.delta?.text ?? "";
          const deltaThinking = event.delta?.thinking ?? (isThinking ? deltaText : "");

          if (isThinking && deltaThinking) {
            fullThinking += deltaThinking;
            onChunk({ content: "", thinking: deltaThinking, done: false });
          } else if (deltaText) {
            const tagged = taggedTextParser.push(deltaText);
            if (tagged.thinking) {
              fullThinking += tagged.thinking;
              onChunk({ content: "", thinking: tagged.thinking, done: false });
            }
            if (tagged.content) {
              fullContent += tagged.content;
              onChunk({ content: tagged.content, done: false });
            }
          }

          if (event.delta?.stop_reason) {
            finishReason = this.mapFinishReason(event.delta.stop_reason);
          }
        }

        if (event.type === "message_start") {
          const usage = event.usage ?? event.message?.usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? inputTokens;
            outputTokens = usage.output_tokens ?? usage.completion_tokens ?? outputTokens;
            reasoningTokens = extractReasoningTokens(usage) ?? reasoningTokens;
          }
        }

        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens ?? event.usage.completion_tokens ?? outputTokens;
          reasoningTokens = extractReasoningTokens(event.usage) ?? reasoningTokens;
        }

        if (event.type === "message_stop" && event.usage) {
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? event.usage.completion_tokens ?? outputTokens;
          reasoningTokens = extractReasoningTokens(event.usage) ?? reasoningTokens;
        }
      } catch {
        // Ignore malformed chunks.
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url: this.endpoint,
          method: "POST",
          headers: createHeaders("minimax", this.apiKey),
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
          onError: (error) => reject(new Error(`${error.code}: ${error.message}`)),
        }
      );
    });

    const taggedRemainder = taggedTextParser.flush();
    if (taggedRemainder.thinking) {
      fullThinking += taggedRemainder.thinking;
    }
    if (taggedRemainder.content) {
      fullContent += taggedRemainder.content;
    }

    onChunk({ content: "", done: true });

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      tokens: {
        input: inputTokens || estimateMessageTokens(messages, body.system),
        output: outputTokens || estimateOutputTokens(fullContent, fullThinking),
        reasoning: reasoningTokens ?? estimateReasoningTokensFromThinking(fullThinking),
      },
      finishReason,
      latencyMs: Date.now() - startTime,
    };
  }

  private mapFinishReason(reason?: string): "stop" | "length" | "error" {
    switch (reason) {
      case "max_tokens":
      case "length":
        return "length";
      case "stop":
      case "end_turn":
      case "tool_use":
        return "stop";
      default:
        return "stop";
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("minimax", this.apiKey),
        body: JSON.stringify({
          model: "MiniMax-M2.5",
          messages: [{ role: "user", content: "Say 'ok'" }],
          max_tokens: 16,
          stream: false,
        }),
        timeoutMs: 15000,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }
}
