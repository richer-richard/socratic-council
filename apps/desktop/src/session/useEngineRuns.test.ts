import {
  DEFAULT_ENGINE_PROTOCOL,
  DEFAULT_ENGINE_SEATS,
  DEFAULT_ENGINE_TOOL_POLICY,
} from "@socratic-council/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __dispatchForTests,
  __peekForTests,
  __resetEngineRunsForTests,
  startEngineRun,
} from "./useEngineRuns";

describe("engine run store", () => {
  beforeEach(() => __resetEngineRunsForTests());

  it("marks the run failed when the engine cannot start (no Tauri here)", async () => {
    await expect(
      startEngineRun({
        topic: "t",
        sessionId: "s1",
        keys: { openai: "k" },
        settings: {
          seats: DEFAULT_ENGINE_SEATS,
          moderator: { provider: "google", model: "auto" },
          utility: { provider: "google", model: "auto-fast" },
          tools: DEFAULT_ENGINE_TOOL_POLICY,
          protocol: DEFAULT_ENGINE_PROTOCOL,
          budget: { perSessionUsd: 0, perDayUsd: 0, action: "warn" },
          baseUrls: {},
          selection: [],
        },
      }),
    ).rejects.toThrow(/desktop app/);
    const view = __peekForTests("s1");
    expect(view?.done).toBe(true);
    expect(view?.stoppedEarly).toBe("failed");
    expect(view?.errors[0]).toMatch(/desktop app/);
  });

  it("folds dispatched events and fires onFinished on done", () => {
    const onFinished = vi.fn();
    __dispatchForTests("s2", { event: "phase", name: "Framing" }, { onFinished });
    __dispatchForTests("s2", { event: "moderator", text: "note" }, { onFinished });
    expect(__peekForTests("s2")?.moderatorNotes).toEqual(["note"]);
    expect(onFinished).not.toHaveBeenCalled();
    __dispatchForTests("s2", { event: "done", session_id: "s2" }, { onFinished });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0]?.[0]).toBe("s2");
    expect(__peekForTests("s2")?.done).toBe(true);
  });
});
