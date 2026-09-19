import { describe, expect, it } from "vitest";

import { redact, redactValue, registerKnownSecrets } from "./redact";

describe("redact: exact known secrets + JWT / Zhipu shapes", () => {
  it("scrubs a registered secret of any shape by value", () => {
    const key = "weird::shape::key::9f8e7d6c5b4a";
    registerKnownSecrets([key, undefined, null, "short"]);
    expect(redact(`provider said: invalid credentials for ${key} (retry)`)).toBe(
      "provider said: invalid credentials for [REDACTED] (retry)",
    );
    // Nested payloads too.
    expect(redactValue({ detail: { message: `bad key ${key}` } })).toEqual({
      detail: { message: "bad key [REDACTED]" },
    });
    // Values under 8 chars are never treated as secrets.
    expect(redact("short is fine")).toBe("short is fine");
    registerKnownSecrets([]);
  });

  it("scrubs JWT-shaped (MiniMax) and id.secret (Zhipu) keys by pattern", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtaW5pbWF4LXVzZXIifQ.abcdefghijklmnopqrstuvwxyz0123";
    expect(redact(`401 for token ${jwt} at minimax`)).toBe("401 for token [REDACTED] at minimax");
    const zhipu = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOpQrSt";
    expect(redact(`bigmodel rejected ${zhipu}.`)).toBe("bigmodel rejected [REDACTED].");
    // A bare 32-hex hash without the `.secret` tail is left alone.
    const hash = "0123456789abcdef0123456789abcdef";
    expect(redact(`commit ${hash}`)).toBe(`commit ${hash}`);
  });
});
