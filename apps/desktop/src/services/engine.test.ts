import {
  DEFAULT_ENGINE_PROTOCOL,
  DEFAULT_ENGINE_SEATS,
  DEFAULT_ENGINE_TOOL_POLICY,
} from "@socratic-council/shared";
import { describe, expect, it } from "vitest";

import { buildStartRequest, isEngineAvailable, startSession, type EngineSettings } from "./engine";

const settings: EngineSettings = {
  seats: DEFAULT_ENGINE_SEATS,
  moderator: { provider: "google", model: "auto" },
  utility: { provider: "google", model: "auto-fast" },
  tools: DEFAULT_ENGINE_TOOL_POLICY,
  protocol: DEFAULT_ENGINE_PROTOCOL,
  budget: { perSessionUsd: 2.5, perDayUsd: 0, action: "stop" },
  baseUrls: { deepseek: "https://api.deepseek.com" },
  selection: [{ provider: "openai", tier: "high", model: "auto" }],
};

describe("engine service", () => {
  it("is unavailable outside Tauri and startSession says so", async () => {
    expect(isEngineAvailable()).toBe(false);
    await expect(startSession({ topic: "t", settings, keys: { openai: "sk-x" } })).rejects.toThrow(
      /desktop app/,
    );
  });

  it("buildStartRequest keeps only keyed seats and their keys", () => {
    const req = buildStartRequest({
      topic: "  Should we?  ",
      settings,
      keys: { openai: "sk-o", anthropic: "  ", google: "g-key" },
      forced: "decision",
    });
    expect(req.topic).toBe("Should we?");
    expect(req.seats.map((s) => s.id)).toEqual(["george", "grace"]);
    expect(Object.keys(req.keys)).toEqual(["openai", "google"]);
    expect(req.forced).toBe("decision");
    expect(req.priorNotes).toBeNull();
    expect(req.sessionId).toBeNull();
    expect(req.budget.action).toBe("stop");
    expect(req.baseUrls.deepseek).toBe("https://api.deepseek.com");
    expect(req.selection[0]?.tier).toBe("high");
    expect(req.proxy).toBeNull();
  });
});

describe("engine settings from the config store", () => {
  it("maps roster, slots, policies, budget, base URLs, overrides and the proxy", async () => {
    const { engineSettingsFromConfig, proxyUrl } = await import("./engine");
    const config = {
      credentials: {
        openai: { apiKey: "sk-o" },
        deepseek: { apiKey: "sk-d", baseUrl: "https://api.deepseek.com/v1" },
      },
      proxy: { type: "socks5h", host: "127.0.0.1", port: 7897, username: "u" },
      preferences: { budget: { perSession: 3, perDay: 10, action: "pause" } },
      modelSelection: {
        openai: { low: "auto", medium: "auto", high: "gpt-6-astra" },
        google: { low: "gemini-3.8-flash", medium: "auto", high: "auto" },
      },
      roster: DEFAULT_ENGINE_SEATS.slice(0, 2),
      moderator: { provider: "anthropic", model: "auto" },
      utility: { provider: "google", model: "auto-fast" },
      tools: DEFAULT_ENGINE_TOOL_POLICY,
      protocol: DEFAULT_ENGINE_PROTOCOL,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = engineSettingsFromConfig(config as any, "p@ss");
    expect(out.seats).toHaveLength(2);
    expect(out.moderator.provider).toBe("anthropic");
    expect(out.budget).toEqual({ perSessionUsd: 3, perDayUsd: 10, action: "stop" });
    expect(out.baseUrls).toEqual({ deepseek: "https://api.deepseek.com/v1" });
    expect(out.selection).toEqual([
      { provider: "openai", tier: "high", model: "gpt-6-astra" },
      { provider: "google", tier: "low", model: "gemini-3.8-flash" },
    ]);
    expect(out.proxy).toBe("socks5h://u:p%40ss@127.0.0.1:7897");
    expect(proxyUrl({ type: "none", host: "x", port: 1 })).toBeUndefined();
    expect(proxyUrl({ type: "http", host: "proxy", port: 0 })).toBeUndefined();
    expect(proxyUrl({ type: "http", host: "proxy", port: 8080 })).toBe("http://proxy:8080");
  });
});

describe("presets", () => {
  it("cut the keyed roster to the preset size in roster order", async () => {
    const { presetSeats } = await import("./engine");
    const keys = { openai: "a", google: "b", kimi: "c", zhipu: "d", minimax: " " };
    expect(presetSeats(DEFAULT_ENGINE_SEATS, keys, "quick").map((s) => s.id)).toEqual([
      "george",
      "grace",
      "kate",
    ]);
    expect(presetSeats(DEFAULT_ENGINE_SEATS, keys, "standard").map((s) => s.id)).toEqual([
      "george",
      "grace",
      "kate",
      "zara",
    ]);
    expect(presetSeats(DEFAULT_ENGINE_SEATS, keys, "full")).toHaveLength(4);
  });
});
