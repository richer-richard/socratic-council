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
