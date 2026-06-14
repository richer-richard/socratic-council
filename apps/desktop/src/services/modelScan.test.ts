import { describe, it, expect } from "vitest";

import { parseModelsResponse, modelsEndpointFor } from "./modelScan";

describe("parseModelsResponse", () => {
  it("parses an OpenAI-style { data: [{id}] } body", () => {
    const body = JSON.stringify({
      object: "list",
      data: [
        { id: "gpt-5.5", created: 1730000000, object: "model" },
        { id: "gpt-5-mini", created: 1720000000, object: "model" },
      ],
    });
    const models = parseModelsResponse("openai", body);
    expect(models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5-mini"]);
    expect(models[0]).toMatchObject({ provider: "openai", source: "scanned", created: 1730000000 });
  });

  it("parses Anthropic display_name + created_at", () => {
    const body = JSON.stringify({
      data: [
        {
          id: "claude-opus-4-8",
          display_name: "Claude Opus 4.8",
          created_at: "2026-01-15T00:00:00Z",
        },
      ],
    });
    const [m] = parseModelsResponse("anthropic", body);
    expect(m?.id).toBe("claude-opus-4-8");
    expect(m?.displayName).toBe("Claude Opus 4.8");
    expect(m?.created).toBe(Math.floor(Date.parse("2026-01-15T00:00:00Z") / 1000));
  });

  it("parses Google models[].name and strips the models/ prefix", () => {
    const body = JSON.stringify({
      models: [
        {
          name: "models/gemini-3.1-pro-preview",
          displayName: "Gemini 3.1 Pro",
          supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        },
        {
          name: "models/text-embedding-004",
          supportedGenerationMethods: ["embedContent"], // filtered out (no generateContent)
        },
      ],
    });
    const models = parseModelsResponse("google", body);
    expect(models.map((m) => m.id)).toEqual(["gemini-3.1-pro-preview"]);
  });

  it("returns [] for unparseable bodies (caller falls back to catalog)", () => {
    expect(parseModelsResponse("openai", "not json")).toEqual([]);
    expect(parseModelsResponse("openai", JSON.stringify({ error: "nope" }))).toEqual([]);
  });
});

describe("modelsEndpointFor", () => {
  it("uses the right per-provider path on default base URLs", () => {
    expect(modelsEndpointFor("openai")).toBe("https://api.openai.com/v1/models");
    expect(modelsEndpointFor("anthropic")).toBe("https://api.anthropic.com/v1/models");
    expect(modelsEndpointFor("google")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
    expect(modelsEndpointFor("deepseek")).toBe("https://api.deepseek.com/v1/models");
    expect(modelsEndpointFor("kimi")).toBe("https://api.moonshot.cn/v1/models");
    // Chinese endpoints whose default base already includes the version segment:
    expect(modelsEndpointFor("qwen")).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
    );
    expect(modelsEndpointFor("zhipu")).toBe("https://open.bigmodel.cn/api/paas/v4/models");
    // MiniMax has no list endpoint.
    expect(modelsEndpointFor("minimax")).toBeNull();
  });

  it("respects a custom base URL override", () => {
    expect(modelsEndpointFor("openai", "https://my-proxy.example.com/v1")).toBe(
      "https://my-proxy.example.com/v1/models",
    );
    expect(modelsEndpointFor("openai", "https://gateway.example.com")).toBe(
      "https://gateway.example.com/v1/models",
    );
  });
});
