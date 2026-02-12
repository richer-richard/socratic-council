/**
 * @fileoverview Google Gemini API provider implementation
 * Uses the Gemini API format with contents, systemInstruction, and generationConfig
 */

import type { AgentConfig, GeminiModel, GeminiRequest } from "@socratic-council/shared";
import { API_ENDPOINTS, getModelInfo } from "@socratic-council/shared";
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

export class GoogleProvider implements BaseProvider {
  readonly provider = "google" as const;
  readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;

  constructor(apiKey: string, options?: { baseUrl?: string; transport?: Transport }) {
    this.apiKey = apiKey;
    this.baseUrl = resolveEndpoint(
      options?.baseUrl,
      "/v1beta/models",
      API_ENDPOINTS.google
    );
    this.transport = options?.transport ?? createFetchTransport();
  }

  /**
   * Build the full API URL for a model
   */
  private getApiUrl(model: GeminiModel, stream: boolean): string {
    const action = stream ? "streamGenerateContent" : "generateContent";
    return `${this.baseUrl}/${model}:${action}`;
  }

  /**
   * Convert ChatMessage array to Gemini contents format
   */
  private formatContents(
    messages: ChatMessage[]
  ): { contents: GeminiRequest["contents"]; systemInstruction?: GeminiRequest["systemInstruction"] } {
    let systemInstruction: GeminiRequest["systemInstruction"] | undefined;
    const contents: GeminiRequest["contents"] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // Extract system instruction
        systemInstruction = {
          parts: [{ text: msg.content }],
        };
      } else {
        // Map roles: "assistant" -> "model", "user" -> "user"
        const role = msg.role === "assistant" ? "model" : "user";
        contents.push({
          role,
          parts: [{ text: msg.content }],
        });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * Build the request body for Gemini API
   */
  private buildRequestBody(
    agent: AgentConfig,
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): GeminiRequest {
    const { contents, systemInstruction } = this.formatContents(messages);
    const modelInfo = getModelInfo(agent.model);

    const request: GeminiRequest = {
      contents,
    };

    if (systemInstruction) {
      request.systemInstruction = systemInstruction;
    }

    // Build generation config
    const generationConfig: GeminiRequest["generationConfig"] = {};

    // Temperature (Gemini supports 0-2)
    const temperature = options.temperature ?? agent.temperature ?? 1;
    generationConfig.temperature = Math.max(0, Math.min(2, temperature));

    // Max output tokens
    if (options.maxTokens) {
      generationConfig.maxOutputTokens = options.maxTokens;
    } else if (agent.maxTokens) {
      generationConfig.maxOutputTokens = agent.maxTokens;
    }

    // Thinking config for models that support it (gemini-2.5-pro, gemini-3-pro-preview)
    if (modelInfo?.supportsThinking && agent.model.includes("pro")) {
      generationConfig.thinkingConfig = {
        thinkingBudget: 8192, // Default thinking budget
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      request.generationConfig = generationConfig;
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
    const url = this.getApiUrl(agent.model as GeminiModel, false);
    const body = this.buildRequestBody(agent, messages, options);

    const { status, body: responseBody } = await this.transport.request({
      url,
      method: "POST",
      headers: createHeaders("google", this.apiKey),
      body: JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Google API error: ${status} - ${responseBody}`);
    }

    const data = JSON.parse(responseBody);
    const latencyMs = Date.now() - startTime;

    // Extract content from Gemini response
    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    
    // Extract token usage
    const usageMetadata = data.usageMetadata ?? {};

    return {
      content,
      tokens: {
        input: usageMetadata.promptTokenCount ?? 0,
        output: usageMetadata.candidatesTokenCount ?? 0,
        reasoning: usageMetadata.thoughtsTokenCount,
      },
      finishReason: this.mapFinishReason(candidate?.finishReason),
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
    const url = `${this.getApiUrl(agent.model as GeminiModel, true)}?alt=sse`;
    const body = this.buildRequestBody(agent, messages, options);

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: "stop" | "length" | "error" = "stop";
    const parser = createSseParser((dataLine) => {
      const jsonStr = dataLine.trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      try {
        const data = JSON.parse(jsonStr);
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if (part.text) {
            fullContent += part.text;
            onChunk({ content: part.text, done: false });
          }
        }

        if (data.usageMetadata) {
          inputTokens = data.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = data.usageMetadata.candidatesTokenCount ?? outputTokens;
          reasoningTokens = data.usageMetadata.thoughtsTokenCount ?? reasoningTokens;
        }

        if (candidate?.finishReason) {
          finishReason = this.mapFinishReason(candidate.finishReason);
        }
      } catch {
        // Skip malformed JSON lines
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.transport.stream(
        {
          url,
          method: "POST",
          headers: createHeaders("google", this.apiKey),
          body: JSON.stringify(body),
          timeoutMs: options.timeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          signal: options.signal,
        },
        {
          onChunk: (text) => {
            parser.push(text);
          },
          onDone: () => {
            parser.flush();
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
   * Map Gemini finish reasons to our standard format
   */
  private mapFinishReason(reason?: string): "stop" | "length" | "error" {
    switch (reason) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
      case "RECITATION":
      case "OTHER":
        return "error";
      default:
        return "stop";
    }
  }

  /**
   * Test the connection to Google API
   */
  async testConnection(): Promise<boolean> {
    try {
      // Use a simple request to test the API key
      const url = `${this.baseUrl}/gemini-2.0-flash-lite:generateContent`;
      const { status } = await this.transport.request({
        url,
        method: "POST",
        headers: createHeaders("google", this.apiKey),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
        timeoutMs: 15000,
      });

      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }
}
