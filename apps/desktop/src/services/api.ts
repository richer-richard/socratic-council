/**
 * API Service - Handles all API calls to AI providers with proper error logging
 * Supports proxy configuration and streaming responses
 */

import type { 
  Provider, 
  ProxyConfig, 
  ProviderCredential
} from "../stores/config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface CompletionResult {
  content: string;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
  };
  latencyMs: number;
  success: boolean;
  error?: string;
}

export type StreamCallback = (chunk: StreamChunk) => void;

// API Endpoints for each provider
const API_ENDPOINTS: Record<Provider, string> = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  kimi: "https://api.moonshot.cn/v1/chat/completions",
};

// Logger for API calls
export const apiLogger = {
  logs: [] as { timestamp: number; level: string; provider: string; message: string; details?: unknown }[],
  
  log(level: "info" | "warn" | "error", provider: string, message: string, details?: unknown) {
    const entry = {
      timestamp: Date.now(),
      level,
      provider,
      message,
      details,
    };
    this.logs.push(entry);
    
    // Keep only last 100 logs
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(-100);
    }
    
    // Also log to console
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleMethod(`[${level.toUpperCase()}] [${provider}] ${message}`, details || "");
  },
  
  getLogs() {
    return [...this.logs];
  },
  
  clearLogs() {
    this.logs = [];
  },
};

/**
 * Build fetch options with proxy support
 * Note: In browser environment, proxy is handled differently.
 * For Tauri app, we'll use the system proxy or configure through Tauri commands.
 */
function buildFetchOptions(
  method: string,
  headers: Record<string, string>,
  body: string,
  proxy?: ProxyConfig
): RequestInit {
  const options: RequestInit = {
    method,
    headers,
    body,
  };
  
  // Log proxy configuration (actual proxy handling would be in Tauri backend)
  if (proxy && proxy.type !== "none") {
    apiLogger.log("info", "proxy", `Using proxy: ${proxy.type}://${proxy.host}:${proxy.port}`);
  }
  
  return options;
}

/**
 * Create headers for each provider
 */
function createHeaders(provider: Provider, apiKey: string): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (provider) {
    case "openai":
      return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    case "anthropic":
      return { 
        ...baseHeaders, 
        "x-api-key": apiKey, 
        "anthropic-version": "2024-01-01" 
      };
    case "google":
      return { ...baseHeaders, "x-goog-api-key": apiKey };
    case "deepseek":
      return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    case "kimi":
      return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    default:
      return baseHeaders;
  }
}

/**
 * OpenAI API call using the Responses API format
 */
async function callOpenAI(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/responses` : API_ENDPOINTS.openai;
  
  apiLogger.log("info", "openai", `Starting request to ${endpoint}`, { model });

  try {
    // Extract system message for instructions
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const input = nonSystemMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const requestBody = {
      model,
      input: input.length === 1 && input[0]?.role === "user" ? input[0].content : input,
      instructions: systemMessage?.content,
      stream: true,
      max_output_tokens: 2048,
    };

    const response = await fetch(endpoint, buildFetchOptions(
      "POST",
      createHeaders("openai", apiKey),
      JSON.stringify(requestBody),
      proxy
    ));

    if (!response.ok) {
      const errorText = await response.text();
      apiLogger.log("error", "openai", `API error: ${response.status}`, errorText);
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.output?.[0]?.content?.[0]?.text || 
                         parsed.choices?.[0]?.delta?.content || "";
          
          if (content) {
            fullContent += content;
            onChunk({ content, done: false });
          }

          if (parsed.usage) {
            inputTokens = parsed.usage.input_tokens || parsed.usage.prompt_tokens || 0;
            outputTokens = parsed.usage.output_tokens || parsed.usage.completion_tokens || 0;
          }
        } catch {
          // Ignore parse errors for incomplete chunks
        }
      }
    }

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    apiLogger.log("info", "openai", `Request completed`, { 
      tokens: { input: inputTokens, output: outputTokens }, 
      latencyMs 
    });

    return {
      content: fullContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "openai", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });
    
    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Anthropic API call using Messages API
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/messages` : API_ENDPOINTS.anthropic;
  
  apiLogger.log("info", "anthropic", `Starting request to ${endpoint}`, { model });

  try {
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const requestBody = {
      model,
      max_tokens: 2048,
      system: systemMessage?.content,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
    };

    const response = await fetch(endpoint, buildFetchOptions(
      "POST",
      createHeaders("anthropic", apiKey),
      JSON.stringify(requestBody),
      proxy
    ));

    if (!response.ok) {
      const errorText = await response.text();
      apiLogger.log("error", "anthropic", `API error: ${response.status}`, errorText);
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6);
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            fullContent += parsed.delta.text;
            onChunk({ content: parsed.delta.text, done: false });
          }
          
          if (parsed.type === "message_delta" && parsed.usage) {
            outputTokens = parsed.usage.output_tokens || 0;
          }
          
          if (parsed.type === "message_start" && parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens || 0;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    apiLogger.log("info", "anthropic", `Request completed`, { 
      tokens: { input: inputTokens, output: outputTokens }, 
      latencyMs 
    });

    return {
      content: fullContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "anthropic", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });
    
    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Google Gemini API call
 */
async function callGoogle(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig
): Promise<CompletionResult> {
  const startTime = Date.now();
  const base = baseUrl || "https://generativelanguage.googleapis.com";
  const endpoint = `${base}/v1beta/models/${model}:streamGenerateContent?key=${apiKey}`;
  
  apiLogger.log("info", "google", `Starting request`, { model });

  try {
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const contents = nonSystemMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const requestBody = {
      contents,
      systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.8,
      },
    };

    const response = await fetch(endpoint, buildFetchOptions(
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify(requestBody),
      proxy
    ));

    if (!response.ok) {
      const errorText = await response.text();
      apiLogger.log("error", "google", `API error: ${response.status}`, errorText);
      throw new Error(`Google API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Google returns JSON array chunks
      try {
        // Try to parse complete JSON objects from buffer
        const jsonMatch = buffer.match(/\{[^{}]*"candidates"[^{}]*\}/g);
        if (jsonMatch) {
          for (const json of jsonMatch) {
            const parsed = JSON.parse(json);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (text) {
              fullContent += text;
              onChunk({ content: text, done: false });
            }
            
            if (parsed.usageMetadata) {
              inputTokens = parsed.usageMetadata.promptTokenCount || 0;
              outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
            }
          }
          buffer = "";
        }
      } catch {
        // Keep accumulating buffer
      }
    }

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    apiLogger.log("info", "google", `Request completed`, { 
      tokens: { input: inputTokens, output: outputTokens }, 
      latencyMs 
    });

    return {
      content: fullContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "google", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });
    
    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * DeepSeek API call (OpenAI-compatible)
 */
async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/chat/completions` : API_ENDPOINTS.deepseek;
  
  apiLogger.log("info", "deepseek", `Starting request to ${endpoint}`, { model });

  try {
    const requestBody = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 2048,
    };

    const response = await fetch(endpoint, buildFetchOptions(
      "POST",
      createHeaders("deepseek", apiKey),
      JSON.stringify(requestBody),
      proxy
    ));

    if (!response.ok) {
      const errorText = await response.text();
      apiLogger.log("error", "deepseek", `API error: ${response.status}`, errorText);
      throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || "";
          
          if (content) {
            fullContent += content;
            onChunk({ content, done: false });
          }

          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || 0;
            outputTokens = parsed.usage.completion_tokens || 0;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    apiLogger.log("info", "deepseek", `Request completed`, { 
      tokens: { input: inputTokens, output: outputTokens }, 
      latencyMs 
    });

    return {
      content: fullContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "deepseek", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });
    
    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Kimi/Moonshot API call (OpenAI-compatible)
 */
async function callKimi(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/chat/completions` : API_ENDPOINTS.kimi;
  
  apiLogger.log("info", "kimi", `Starting request to ${endpoint}`, { model });

  try {
    const requestBody = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 2048,
    };

    const response = await fetch(endpoint, buildFetchOptions(
      "POST",
      createHeaders("kimi", apiKey),
      JSON.stringify(requestBody),
      proxy
    ));

    if (!response.ok) {
      const errorText = await response.text();
      apiLogger.log("error", "kimi", `API error: ${response.status}`, errorText);
      throw new Error(`Kimi API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || "";
          
          if (content) {
            fullContent += content;
            onChunk({ content, done: false });
          }

          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || 0;
            outputTokens = parsed.usage.completion_tokens || 0;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    apiLogger.log("info", "kimi", `Request completed`, { 
      tokens: { input: inputTokens, output: outputTokens }, 
      latencyMs 
    });

    return {
      content: fullContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "kimi", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });
    
    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Main function to call any provider
 */
export async function callProvider(
  provider: Provider,
  credential: ProviderCredential,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  proxy?: ProxyConfig
): Promise<CompletionResult> {
  apiLogger.log("info", provider, `Initiating API call`, { model, messageCount: messages.length });

  switch (provider) {
    case "openai":
      return callOpenAI(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy);
    case "anthropic":
      return callAnthropic(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy);
    case "google":
      return callGoogle(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy);
    case "deepseek":
      return callDeepSeek(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy);
    case "kimi":
      return callKimi(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy);
    default:
      apiLogger.log("error", provider, `Unknown provider`);
      return {
        content: "",
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        success: false,
        error: `Unknown provider: ${provider}`,
      };
  }
}
