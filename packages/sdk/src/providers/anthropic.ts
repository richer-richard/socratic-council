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

import type { AgentConfig, AnthropicModel, ReasoningTier } from "@socratic-council/shared";
import { API_ENDPOINTS } from "@socratic-council/shared";

import { type Transport, createFetchTransport } from "../transport.js";

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

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
      cache_control?: { type: "ephemeral" };
    }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
      title?: string;
      cache_control?: { type: "ephemeral" };
    };

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?:
    | {
        type: "enabled";
        budget_tokens: number;
      }
    | {
        type: "adaptive";
        /** "summarized" returns thinking text; the 4.7+/5.x default is "omitted" (empty). */
        display?: "summarized" | "omitted";
      }
    | { type: "disabled" };
  /** Top-level effort knob (4.6+ and all 5.x models). Omitted == "high" (the default). */
  output_config?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
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
    text?: string;
    thinking?: string;
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
  index?: number;
  content_block?: {
    type?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    stop_reason?: string;
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

type AnthropicThinkingMode = "adaptive" | "extended" | "none";

interface AnthropicThinkingProfile {
  mode: AnthropicThinkingMode;
  /** Opus 4.7 & 4.8's adaptive mode rejects any non-default sampling param (400). */
  prohibitsSampling: boolean;
}

/**
 * Per-model thinking capability. Adaptive thinking is NOT monotonic across
 * the Claude line — wire each generation explicitly:
 *  - Opus 4.6 INTRODUCED adaptive thinking (extended budgets still allowed).
 *  - Opus 4.7 made adaptive the ONLY thinking-on mode (extended budget → 400)
 *    and rejects non-default sampling params.
 *  - Opus 4.8 keeps adaptive-only (NOT a revert): the live API rejects
 *    `thinking.type.enabled` ("Use thinking.type.adaptive") and an explicit
 *    temperature, both 400 — identical to 4.7. (Verified against the live API;
 *    sending an extended budget here silently 400s every turn and falls back to
 *    the previous-gen opus-4-7. See [[anthropic-thinking-profile]] / cli ant_profile.)
 *  - Other 4.x (Sonnet 4 / Haiku 4 / Opus 4.1 / 4.5): extended budgets.
 *  - Claude 3.x and anything else: no thinking.
 */
function anthropicThinkingProfile(model: AnthropicModel): AnthropicThinkingProfile {
  // Claude 5 generation (Opus 5 / Sonnet 5 / Fable 5 / Fable 5.1): thinking is ON by
  // default and adaptive-only (extended budgets are not accepted), sampling params
  // are rejected like 4.7/4.8, and depth is steered with `output_config.effort`.
  if (isClaude5(model)) return { mode: "adaptive", prohibitsSampling: true };
  if (model.includes("opus-4-8")) return { mode: "adaptive", prohibitsSampling: true };
  if (model.includes("opus-4-7")) return { mode: "adaptive", prohibitsSampling: true };
  if (model.includes("opus-4-6")) return { mode: "adaptive", prohibitsSampling: false };
  if (model.includes("opus-4") || model.includes("sonnet-4") || model.includes("haiku-4")) {
    return { mode: "extended", prohibitsSampling: false };
  }
  return { mode: "none", prohibitsSampling: false };
}

/** Claude 5.x ids: `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-fable-5-1`, … */
function isClaude5(model: string): boolean {
  return /-(opus|sonnet|haiku|fable)-5(?:-|$)/.test(model);
}

/** Fable models cannot turn thinking off (`thinking.type: "disabled"` is a 400). */
function thinkingAlwaysOn(model: string): boolean {
  return model.includes("fable");
}

/**
 * `output_config.effort` for the council tier on adaptive-thinking models. "high" is
 * the API default, so it is omitted; low/medium are sent explicitly.
 */
function effortForTier(tier: ReasoningTier | undefined): "low" | "medium" | undefined {
  if (tier === "low") return "low";
  if (tier === "medium") return "medium";
  return undefined;
}

/** Extended-thinking budget for the requested tier (undefined → omit thinking). */
function extendedBudgetForTier(
  tier: ReasoningTier | undefined,
  maxTokens: number,
): number | undefined {
  if (tier === "low") return undefined; // fast tier: skip extended thinking
  const cap = tier === "medium" ? 4096 : 8192; // high / unset → richer budget
  // Anthropic requires max_tokens > thinking.budget_tokens.
  const budget = Math.min(cap, maxTokens - 256);
  return budget >= 1024 ? budget : undefined;
}

function buildThinkingConfig(
  model: AnthropicModel,
  maxTokens: number,
  options?: CompletionOptions,
):
  | {
      type: "enabled";
      budget_tokens: number;
    }
  | {
      type: "adaptive";
      display?: "summarized" | "omitted";
    }
  | { type: "disabled" }
  | undefined {
  const profile = anthropicThinkingProfile(model);
  const tier = options?.reasoningTier;
  const claude5 = isClaude5(model);

  if (options?.disableThinking) {
    // 5.x thinks by default, so "off" has to be sent explicitly — except on Fable,
    // which rejects it; there we omit the block and rely on effort=low instead.
    if (claude5 && !thinkingAlwaysOn(model)) return { type: "disabled" };
    return undefined;
  }

  if (profile.mode === "none") return undefined;
  if (profile.mode === "adaptive") {
    if (tier === "low") {
      // Fast tier: 4.x omits thinking (off); Opus/Sonnet 5 must say so explicitly;
      // Fable keeps thinking on (cannot be disabled) and is throttled via effort.
      if (claude5 && !thinkingAlwaysOn(model)) return { type: "disabled" };
      return undefined;
    }
    // `display: "summarized"` is what makes the thinking text stream at all — the
    // 4.7+/5.x default is "omitted", which returns empty thinking blocks.
    return { type: "adaptive", display: "summarized" };
  }
  const budget = extendedBudgetForTier(tier, maxTokens);
  return budget ? { type: "enabled", budget_tokens: budget } : undefined;
}

function mapStopReason(reason?: string): "stop" | "length" | "error" {
  if (!reason || reason === "end_turn" || reason === "stop_sequence" || reason === "tool_use") {
    return "stop";
  }
  if (reason === "max_tokens") {
    return "length";
  }
  return "error";
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
    options?: CompletionOptions,
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

    let data: AnthropicResponse;
    try {
      data = JSON.parse(body) as AnthropicResponse;
    } catch {
      throw new Error(`Anthropic API returned invalid JSON: ${body.slice(0, 200)}`);
    }
    const latencyMs = Date.now() - startTime;

    // Extract content from the response
    const content = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const thinking = data.content
      .filter((c) => c.type === "thinking")
      .map((c) => c.thinking ?? c.text ?? "")
      .join("");

    return {
      content,
      thinking: thinking || undefined,
      tokens: {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
        reasoning: thinking ? data.usage.output_tokens : undefined,
      },
      finishReason: mapStopReason(data.stop_reason),
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
    const model = agent.model as AnthropicModel;

    const requestBody = this.buildRequestBody(agent, messages, model, {
      ...options,
      stream: true,
    });

    let fullContent = "";
    let fullThinking = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: "stop" | "length" | "error" = "stop";
    const blockTypes = new Map<number, string>();
    const parser = createSseParser((dataLine) => {
      const data = dataLine.trim();
      if (!data || data === "[DONE]") return;
      try {
        const event = JSON.parse(data) as AnthropicStreamEvent;

        if (event.type === "content_block_start") {
          const idx = typeof event.index === "number" ? event.index : -1;
          if (idx >= 0) {
            blockTypes.set(idx, event.content_block?.type ?? "text");
          }
        }

        if (event.type === "content_block_delta" && (event.delta?.text || event.delta?.thinking)) {
          const idx = typeof event.index === "number" ? event.index : -1;
          const blockType = idx >= 0 ? blockTypes.get(idx) : undefined;
          const deltaType = event.delta.type ?? "";
          const isThinking = blockType === "thinking" || deltaType.includes("thinking");
          const thinkingDelta = event.delta.thinking ?? event.delta.text ?? "";
          const textDelta = event.delta.text ?? "";

          if (isThinking) {
            if (thinkingDelta) {
              fullThinking += thinkingDelta;
              onChunk({ content: "", thinking: thinkingDelta, done: false });
            }
          } else if (textDelta) {
            fullContent += textDelta;
            onChunk({ content: textDelta, done: false });
          }
        }

        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens;
        }
        if (event.type === "message_delta" && event.delta?.stop_reason) {
          finishReason = mapStopReason(event.delta.stop_reason);
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
    });

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
        reasoning: fullThinking ? outputTokens : undefined,
      },
      finishReason,
      latencyMs,
    };
  }

  async testConnection(model?: string): Promise<boolean> {
    try {
      const { status } = await this.transport.request({
        url: this.endpoint,
        method: "POST",
        headers: createHeaders("anthropic", this.apiKey),
        body: JSON.stringify({
          // Fix 6.2: prefer the caller's pinned model (typically LOCKED_MODELS).
          // Fall back to Haiku so the test still works when no model is supplied.
          model: model ?? "claude-haiku-4-5-20251001",
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
    options?: CompletionOptions & { stream?: boolean },
  ): AnthropicRequest {
    // Extract system message
    const systemMessage = messages.find((m) => m.role === "system");

    // Filter and convert messages (Anthropic doesn't support system role in messages)
    const anthropicMessages: AnthropicMessage[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: this.buildMessageContent(m),
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

    const thinking = buildThinkingConfig(model, request.max_tokens, options);
    if (thinking) {
      request.thinking = thinking;
    }
    // Effort (4.6+ / 5.x): low/medium tiers are sent explicitly, high is the default.
    if (anthropicThinkingProfile(model).mode === "adaptive") {
      const effort = effortForTier(options?.reasoningTier);
      if (effort) request.output_config = { effort };
    }
    if (!thinking && !anthropicThinkingProfile(model).prohibitsSampling) {
      // Anthropic thinking mode is not compatible with temperature overrides.
      // Opus 4.7 rejects sampling params at any non-default value.
      const temp = options?.temperature ?? agent.temperature ?? 1;
      request.temperature = Math.min(1, Math.max(0, temp));
    }

    return request;
  }

  private buildMessageContent(message: ChatMessage): string | AnthropicContentBlock[] {
    const shouldCache = message.cacheControl === "ephemeral";
    if (message.role !== "user") {
      return message.content;
    }

    const content: AnthropicContentBlock[] = [];

    const pushText = (cache = false) => {
      if (!message.content.trim()) return;
      content.push({
        type: "text",
        text: message.content,
        ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      });
    };

    const pushAttachments = () => {
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind === "image") {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType,
              data: attachment.data,
            },
          });
          continue;
        }

        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: attachment.mimeType,
            data: attachment.data,
          },
          title: attachment.name,
        });
      }
    };

    if (shouldCache && (message.attachments?.length ?? 0) > 0) {
      pushAttachments();
      pushText(true);
    } else {
      pushText(shouldCache);
      pushAttachments();
    }

    return content.length > 0 ? content : message.content;
  }
}
