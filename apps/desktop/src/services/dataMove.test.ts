import { describe, expect, it } from "vitest";

import { blockedMessage, holdsAppStorage, unreadMessage } from "./dataMove";

describe("holdsAppStorage", () => {
  it("counts the app's own keys and nothing else", () => {
    expect(holdsAppStorage([])).toBe(false);
    expect(holdsAppStorage(["something-else", "socratic-council-sync-seen:x"])).toBe(false);
    expect(holdsAppStorage(["socratic-council-config"])).toBe(true);
    expect(holdsAppStorage(["socratic-council-session-index-v1"])).toBe(true);
    expect(holdsAppStorage(["socratic-council-secret:apiKey:openai"])).toBe(true);
  });
});

describe("blockedMessage", () => {
  const container = "/Users/me/Library/Containers/x";

  it("tells the user to quit and reopen, and where the data is", () => {
    const text = blockedMessage({
      state: "failed",
      reason: "Copying it failed: disk full.",
      container,
    });
    expect(text).toContain("Copying it failed: disk full.");
    expect(text).toContain(container);
    expect(text).toContain("Quit Socratic Council and open it again");
    const pending = blockedMessage({ state: "pending", reason: null, container });
    expect(pending).toContain("Quit Socratic Council and open it again");
  });

  it("is not the reason when the move is done or never needed", () => {
    expect(blockedMessage(null)).toBeNull();
    expect(blockedMessage({ state: "moved", reason: null, container: null })).toBeNull();
    expect(blockedMessage({ state: "not_needed", reason: null, container: null })).toBeNull();
  });

  it("keeps the visible copy free of semicolons and dashes", () => {
    const all = [
      blockedMessage({ state: "failed", reason: "x.", container }),
      unreadMessage(container),
      unreadMessage(null),
    ];
    for (const text of all) expect(text).not.toMatch(/[;—–]/);
  });
});
