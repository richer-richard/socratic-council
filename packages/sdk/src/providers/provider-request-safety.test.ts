import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@socratic-council/shared";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { MiniMaxProvider } from "./minimax.js";

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
    const request = (provider as unknown as {
      buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
    }).buildRequestBody(
      createAgent({ provider: "openai", model: "gpt-5.3-codex" }),
      messages,
      "gpt-5.3-codex",
      { stream: false }
    );

    expect(request.temperature).toBeUndefined();
    expect(request.reasoning).toMatchObject({ effort: "xhigh", summary: "auto" });
  });

  it("uses adaptive thinking and no temperature for Claude Opus 4.6", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (provider as unknown as {
      buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
    }).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-opus-4-6",
        maxTokens: 8192,
      }),
      messages,
      "claude-opus-4-6",
      { stream: false }
    );

    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.temperature).toBeUndefined();
  });

  it("keeps Anthropic budget_tokens strictly below max_tokens", () => {
    const provider = new AnthropicProvider("test-key");
    const request = (provider as unknown as {
      buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
    }).buildRequestBody(
      createAgent({
        id: "cathy",
        name: "Cathy",
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        maxTokens: 1500,
      }),
      messages,
      "claude-sonnet-4-5-20250929",
      { stream: false }
    );

    const thinking = request.thinking as { budget_tokens: number } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking?.budget_tokens).toBeLessThan(request.max_tokens as number);
  });

  it("keeps MiniMax budget_tokens strictly below max_tokens", () => {
    const provider = new MiniMaxProvider("test-key");
    const request = (provider as unknown as {
      buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
    }).buildRequestBody(
      createAgent({
        id: "mary",
        name: "Mary",
        provider: "minimax",
        model: "minimax-m2.5",
        maxTokens: 4096,
      }),
      messages,
      {},
      false
    );

    const thinking = request.thinking as { budget_tokens: number } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking?.budget_tokens).toBeLessThan(request.max_tokens as number);
  });
});
