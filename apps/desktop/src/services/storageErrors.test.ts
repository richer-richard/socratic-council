import { describe, expect, it } from "vitest";

import { describeSaveFailure, isQuotaExceededError } from "./storageErrors";

describe("isQuotaExceededError", () => {
  it("recognises the WebKit / Blink DOMException by name", () => {
    expect(isQuotaExceededError({ name: "QuotaExceededError", message: "" })).toBe(true);
  });

  it("recognises the legacy DOMException codes", () => {
    expect(isQuotaExceededError({ name: "Error", code: 22, message: "" })).toBe(true);
    expect(isQuotaExceededError({ name: "Error", code: 1014, message: "" })).toBe(true);
  });

  it("recognises a quota mention in the message", () => {
    expect(isQuotaExceededError(new Error("quota exceeded"))).toBe(true);
  });

  it("does not treat other failures as a full store", () => {
    expect(isQuotaExceededError(new Error("vault: cannot decrypt, DEK not loaded"))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError("boom")).toBe(false);
  });
});

describe("describeSaveFailure", () => {
  it("names the store limit and the remedy, never a browser, when the quota is hit", () => {
    const text = describeSaveFailure(
      "session",
      Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" }),
    );
    expect(text).toContain("store is full");
    expect(text).toContain("5 MB");
    expect(text).toContain("delete older sessions");
    expect(text).not.toMatch(/browser/i);
  });

  it("points at the disk, not the 5 MB cap, when the session store is full", () => {
    const text = describeSaveFailure(
      "session",
      Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" }),
      "sessions",
    );
    expect(text).toContain("session store is full");
    expect(text).toContain("disk");
    expect(text).not.toContain("5 MB");
    expect(text).not.toMatch(/browser/i);
  });

  it("tells a project to clear projects, not sessions", () => {
    const text = describeSaveFailure(
      "project",
      Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" }),
    );
    expect(text).toContain("Delete projects");
    expect(text).not.toContain("sessions in the sidebar");
  });

  it("carries the real reason for any other failure and does not blame space", () => {
    const text = describeSaveFailure("project", new Error("vault: cannot decrypt, DEK not loaded"));
    expect(text).toBe("Failed to save the project locally: vault: cannot decrypt, DEK not loaded");
    expect(text).not.toContain("full");
  });

  it("redacts key-shaped tokens in the reason", () => {
    const text = describeSaveFailure(
      "session",
      new Error("rejected key sk-fake012345678901234567"),
    );
    expect(text).not.toContain("sk-fake012345678901234567");
  });

  it("copes with a non-Error throw", () => {
    expect(describeSaveFailure("session", "boom")).toBe("Failed to save the session locally: boom");
    expect(describeSaveFailure("session", undefined)).toBe(
      "Failed to save the session locally: unknown error",
    );
  });
});
