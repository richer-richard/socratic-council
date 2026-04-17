import { describe, it, expect } from "vitest";

import { redact, redactValue } from "./redact";

describe("redact — string patterns", () => {
  it("strips Bearer tokens", () => {
    const input = "Authorization: Bearer sk-proj-verySecretToken12345678";
    const out = redact(input);
    expect(out).not.toContain("sk-proj-verySecretToken12345678");
    expect(out).toContain("Authorization: Bearer [REDACTED]");
  });

  it("strips x-api-key values", () => {
    const input = "x-api-key: sk-ant-abcd1234efgh5678ijkl\nmore text";
    const out = redact(input);
    expect(out).not.toContain("sk-ant-abcd1234efgh5678ijkl");
    expect(out).toMatch(/x-api-key:\s*\[REDACTED\]/i);
  });

  it("strips x-goog-api-key values", () => {
    const input = "x-goog-api-key: AIzaSomethingVerySecretHere";
    const out = redact(input);
    expect(out).not.toContain("AIzaSomethingVerySecretHere");
  });

  it("scrubs userinfo from proxy URLs", () => {
    const input = "http://me:p%40ss@proxy.local:3128/outbound";
    const out = redact(input);
    expect(out).not.toContain("me:p%40ss");
    expect(out).toContain("[REDACTED]@proxy.local:3128");
  });

  it("scrubs loose sk- keys in prose", () => {
    const input = "User reported error, key sk-fake012345678901234567 in logs";
    const out = redact(input);
    expect(out).not.toContain("sk-fake012345678901234567");
  });

  it("leaves normal prose alone", () => {
    const input = "This is just a normal message with nothing sensitive.";
    expect(redact(input)).toBe(input);
  });
});

describe("redactValue — structured payloads", () => {
  it("redacts headers in nested objects", () => {
    const payload = {
      request: {
        url: "https://api.openai.com/v1/chat",
        headers: {
          Authorization: "Bearer sk-anthropic-key",
          "Content-Type": "application/json",
        },
      },
    };
    const out = redactValue(payload) as typeof payload;
    expect(out.request.headers.Authorization).toBe("[REDACTED]");
    expect(out.request.headers["Content-Type"]).toBe("application/json");
  });

  it("redacts apiKey fields regardless of nesting", () => {
    const payload = {
      credentials: {
        openai: { apiKey: "sk-openaiSecretKey12345" },
        anthropic: { apiKey: "sk-ant-anthropicSecretKey" },
      },
    };
    const out = redactValue(payload) as {
      credentials: Record<string, { apiKey: string }>;
    };
    expect(out.credentials.openai.apiKey).toBe("[REDACTED]");
    expect(out.credentials.anthropic.apiKey).toBe("[REDACTED]");
  });

  it("redacts password / secret fields", () => {
    const payload = { proxy: { username: "alice", password: "hunter2" } };
    const out = redactValue(payload) as { proxy: Record<string, string> };
    expect(out.proxy.username).toBe("alice");
    expect(out.proxy.password).toBe("[REDACTED]");
  });

  it("stringifies and redacts Error instances", () => {
    const err = new Error(
      "Request failed: http://bob:hunter2@proxy.local:3128 — Bearer sk-fake12345678",
    );
    const out = redactValue(err);
    expect(typeof out).toBe("string");
    const s = out as string;
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("sk-fake12345678");
  });
});
