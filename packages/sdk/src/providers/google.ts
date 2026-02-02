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
import { createHeaders } from "./base.js";

export class GoogleProvider implements BaseProvider {
  readonly provider = "google" as const;
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Build the full API URL for a model
   */
  private getApiUrl(model: GeminiModel, stream: boolean): string {
    const baseUrl = API_ENDPOINTS.google;
    const action = stream ? "streamGenerateContent" : "generateContent";
    return `${baseUrl}/${model}:${action}`;
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

    const response = await fetch(url, {
      method: "POST",
      headers: createHeaders("google", this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
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

    const response = await fetch(url, {
      method: "POST",
      headers: createHeaders("google", this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error: ${response.status} - ${error}`);
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
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const data = JSON.parse(jsonStr);
              
              // Extract content from streaming response
              const candidate = data.candidates?.[0];
              const parts = candidate?.content?.parts ?? [];
              
              for (const part of parts) {
                if (part.text) {
                  fullContent += part.text;
                  onChunk({ content: part.text, done: false });
                }
              }

              // Update token counts if available
              if (data.usageMetadata) {
                inputTokens = data.usageMetadata.promptTokenCount ?? inputTokens;
                outputTokens = data.usageMetadata.candidatesTokenCount ?? outputTokens;
                reasoningTokens = data.usageMetadata.thoughtsTokenCount ?? reasoningTokens;
              }

              // Check finish reason
              if (candidate?.finishReason) {
                finishReason = this.mapFinishReason(candidate.finishReason);
              }
            } catch {
              // Skip malformed JSON lines
            }
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
      const url = `${API_ENDPOINTS.google}/gemini-2.0-flash-lite:generateContent`;
      const response = await fetch(url, {
        method: "POST",
        headers: createHeaders("google", this.apiKey),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
