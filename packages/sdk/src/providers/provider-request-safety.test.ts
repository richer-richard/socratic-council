import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@socratic-council/shared";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { MiniMaxProvider } from "./minimax.js";
import { GoogleProvider } from "./google.js";
import { DeepSeekProvider } from "./deepseek.js";
import { ZhipuProvider } from "./zhipu.js";
import { createHeaders } from "./base.js";

const messages = [
  { role: "system" as const, content: "System prompt" },
  { role: "user" as const, content: "Hello" },
];

function createAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: "george",
    name: "George",
    provider: "openai",
    model: "gpt-5.3-codex",
    systemPrompt: "System prompt",
    temperature: 1,
    maxTokens: 4096,
    ...overrides,
  } as AgentConfig;
}

describe("provider request safety", () => {
  it("omits temperature and uses xhigh reasoning for GPT-5.3-codex", () => {
    const provider = new OpenAIProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "openai", model: "gpt-5.3-codex" }),
      messages,
      "gpt-5.3-codex",
      { stream: false },
    );

    expect(request.temperature).toBeUndefined();
    expect(request.reasoning).toMatchObject({ effort: "xhigh", summary: "auto" });
  });

  it("uses adaptive thinking and no temperature for Claude Opus 4.6", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-opus-4-6",
        maxTokens: 8192,
      }),
      messages,
      "claude-opus-4-6",
      { stream: false },
    );

    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.temperature).toBeUndefined();
  });

  it("uses adaptive thinking and omits temperature for Claude Opus 4.7", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-opus-4-7",
        maxTokens: 8192,
      }),
      messages,
      "claude-opus-4-7",
      { stream: false },
    );

    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.temperature).toBeUndefined();
    expect(request.top_p).toBeUndefined();
  });

  it("omits temperature for Opus 4.7 even when thinking is disabled", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-opus-4-7",
        maxTokens: 8192,
      }),
      messages,
      "claude-opus-4-7",
      { stream: false, disableThinking: true },
    );

    expect(request.thinking).toBeUndefined();
    expect(request.temperature).toBeUndefined();
  });

  it("can disable Anthropic thinking for forced final-answer retries", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-opus-4-6",
        maxTokens: 8192,
      }),
      messages,
      "claude-opus-4-6",
      { stream: false, disableThinking: true },
    );

    expect(request.thinking).toBeUndefined();
    expect(request.temperature).toBe(1);
  });

  it("keeps Anthropic budget_tokens strictly below max_tokens", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        maxTokens: 1500,
      }),
      messages,
      "claude-sonnet-4-5-20250929",
      { stream: false },
    );

    const thinking = request.thinking as { budget_tokens: number } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking?.budget_tokens).toBeLessThan(request.max_tokens as number);
  });

  it("keeps MiniMax budget_tokens strictly below max_tokens", () => {
    const provider = new MiniMaxProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "mary",
        name: "Mary",
        provider: "minimax",
        model: "minimax-m2.7-highspeed",
        maxTokens: 4096,
      }),
      messages,
      {},
      false,
    );

    const thinking = request.thinking as { budget_tokens: number } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking?.budget_tokens).toBeLessThan(request.max_tokens as number);
  });

  it("adds an OpenAI prompt cache key for stable attachment context", () => {
    const provider = new OpenAIProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "openai", model: "gpt-5.3-codex" }),
      [
        { role: "system" as const, content: "System prompt" },
        {
          role: "user" as const,
          content: 'Discussion topic: "Cached prompt"',
          cacheControl: "ephemeral" as const,
        },
        { role: "user" as const, content: "Your turn." },
      ],
      "gpt-5.3-codex",
      { stream: false },
    );

    expect(request.prompt_cache_key).toMatch(/^sc-prefix-/);
    expect(request.prompt_cache_retention).toBe("in_memory");
  });

  it("marks Anthropic attachment prefix blocks as cacheable", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-opus-4-6",
        maxTokens: 8192,
      }),
      [
        { role: "system" as const, content: "System prompt" },
        {
          role: "user" as const,
          content: 'Discussion topic: "Cached prompt"',
          cacheControl: "ephemeral" as const,
          attachments: [
            {
              id: "att_1",
              kind: "image" as const,
              name: "chart.jpg",
              mimeType: "image/jpeg",
              data: "ZmFrZQ==",
            },
          ],
        },
      ],
      "claude-opus-4-6",
      { stream: false },
    );

    const content = (request.messages as Array<{ content: unknown }>)[0]?.content as Array<
      Record<string, unknown>
    >;
    const lastBlock = content.at(-1);
    expect(Array.isArray(content)).toBe(true);
    expect(lastBlock?.type).toBe("text");
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("createHeaders coverage (fix 4.5 / 12.1)", () => {
  it("anthropic includes the prompt-caching beta header", () => {
    const headers = createHeaders("anthropic", "sk-ant-test");
    expect(headers["anthropic-beta"]).toContain("prompt-caching");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("minimax uses the anthropic-compatible auth shape WITHOUT the caching beta", () => {
    const headers = createHeaders("minimax", "sk-test");
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers).not.toHaveProperty("anthropic-beta");
  });

  it("openai uses Bearer auth", () => {
    const headers = createHeaders("openai", "sk-openai");
    expect(headers.Authorization).toBe("Bearer sk-openai");
  });

  it("google uses x-goog-api-key", () => {
    const headers = createHeaders("google", "AIza-test");
    expect(headers["x-goog-api-key"]).toBe("AIza-test");
  });
});

describe("Google provider request shape (fix 12.1)", () => {
  it("clamps temperature to [0..2] in generationConfig", () => {
    const provider = new GoogleProvider("AIza-test");
    const body = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "google", model: "gemini-3.1-pro-preview" }),
      messages,
      { temperature: 5 },
    );
    const generationConfig = body.generationConfig as Record<string, number>;
    expect(generationConfig.temperature).toBeLessThanOrEqual(2);
    expect(generationConfig.temperature).toBeGreaterThanOrEqual(0);
  });

  it("extracts the system prompt as systemInstruction", () => {
    const provider = new GoogleProvider("AIza-test");
    const body = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "google", model: "gemini-3.1-pro-preview" }),
      messages,
    );
    expect(body.systemInstruction).toBeDefined();
    const contents = body.contents as Array<{ role: string }>;
    // The system message should not appear inside contents.
    expect(contents.every((c) => c.role !== "system")).toBe(true);
  });
});

describe("DeepSeek + Zhipu request shapes (fix 12.1)", () => {
  it("DeepSeek uses Bearer auth and stream=true via OpenAI-compatible body", () => {
    const provider = new DeepSeekProvider("sk-deepseek-test");
    const body = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "deepseek", model: "deepseek-chat" }),
      messages,
      {},
      true,
    );
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual(messages);
  });

  it("Zhipu accepts temperature up to 2 (fix 6.3)", () => {
    const provider = new ZhipuProvider("test-key");
    const body = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "zhipu", model: "glm-5.1" }),
      messages,
      { temperature: 1.7 },
      false,
    );
    expect(body.temperature).toBeCloseTo(1.7, 5);
  });

  it("Zhipu clamps oversized temperature to 2", () => {
    const provider = new ZhipuProvider("test-key");
    const body = (
      provider as unknown as {
        buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
      }
    ).buildRequestBody(
      createAgent({ provider: "zhipu", model: "glm-5.1" }),
      messages,
      { temperature: 5 },
      false,
    );
    expect(body.temperature).toBe(2);
  });
});
