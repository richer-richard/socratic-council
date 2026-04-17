import { describe, it, expect, vi } from "vitest";

import { reflectAndRevise, __testing } from "./reflection.js";

describe("reflectAndRevise — mode gates", () => {
  it('returns null and does NOT call the provider when mode is "off"', async () => {
    const complete = vi.fn();
    const result = await reflectAndRevise(
      {
        systemPrompt: "You are George.",
        draft: "Some draft.",
        currentSpeakerSituation: "Topic: X",
      },
      "off",
      complete,
    );
    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns null when the draft is empty", async () => {
    const complete = vi.fn();
    const result = await reflectAndRevise(
      { systemPrompt: "x", draft: "   ", currentSpeakerSituation: "y" },
      "light",
      complete,
    );
    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns null when the completion fails", async () => {
    const complete = vi.fn().mockResolvedValue(null);
    const result = await reflectAndRevise(
      { systemPrompt: "x", draft: "draft", currentSpeakerSituation: "y" },
      "light",
      complete,
    );
    expect(result).toBeNull();
  });
});

describe("reflectAndRevise — prompt shape", () => {
  it("preserves the system prompt verbatim", async () => {
    const complete = vi.fn().mockResolvedValue("revised output");
    const systemPrompt = "You are Cathy, an ethics-focused agent.";
    await reflectAndRevise(
      {
        systemPrompt,
        draft: "original draft",
        currentSpeakerSituation: "The topic is consent.",
        agentName: "Cathy",
      },
      "deep",
      complete,
    );
    const arg = complete.mock.calls[0]![0] as { system: string; user: string };
    expect(arg.system).toBe(systemPrompt);
  });

  it("uses the light rubric for mode=light", async () => {
    const complete = vi.fn().mockResolvedValue("tight");
    await reflectAndRevise(
      {
        systemPrompt: "x",
        draft: "verbose draft",
        currentSpeakerSituation: "y",
      },
      "light",
      complete,
    );
    const arg = complete.mock.calls[0]![0] as { system: string; user: string };
    expect(arg.user).toContain(__testing.LIGHT_RUBRIC);
    expect(arg.user).not.toContain("rubric before rewriting"); // deep marker
  });

  it("uses the deep rubric for mode=deep", async () => {
    const complete = vi.fn().mockResolvedValue("revised");
    await reflectAndRevise(
      {
        systemPrompt: "x",
        draft: "sprawling draft",
        currentSpeakerSituation: "y",
      },
      "deep",
      complete,
    );
    const arg = complete.mock.calls[0]![0] as { system: string; user: string };
    expect(arg.user).toContain("rubric before rewriting");
    expect(arg.user).toContain("hidden assumption");
  });
});

describe("reflectAndRevise — no-op on verbatim echo", () => {
  it("treats an identical echo as a failure and returns null", async () => {
    const draft = "Exactly what the model will echo.";
    const complete = vi.fn().mockResolvedValue(draft);
    const result = await reflectAndRevise(
      { systemPrompt: "x", draft, currentSpeakerSituation: "y" },
      "light",
      complete,
    );
    expect(result).toBeNull();
  });
});
