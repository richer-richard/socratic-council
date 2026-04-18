import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiKeyAccount,
  isKeychainAvailable,
  isSecretStoreReady,
  secretsDelete,
  secretsGet,
  secretsPut,
} from "./secrets";
import * as vault from "./vault";

// Install a minimal localStorage shim under the default "node" test env.
beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  }
});

function fixedDek(): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (i * 13 + 7) & 0xff;
  return out;
}

describe("secrets — localStorage + vault", () => {
  beforeEach(() => {
    localStorage.clear();
    vault.__resetVaultForTests();
  });
  afterEach(() => {
    vault.__resetVaultForTests();
  });

  it("writes values through the vault when ready — stored form is encrypted", () => {
    vault.__setDekForTests(fixedDek());
    expect(isSecretStoreReady()).toBe(true);

    secretsPut(apiKeyAccount("openai"), "sk-secret-key-value");
    const raw = localStorage.getItem("socratic-council-secret:apiKey:openai");
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("sk-secret-key-value");
    expect(raw!.startsWith("ENC1:")).toBe(true);
  });

  it("round-trips values via secretsGet", () => {
    vault.__setDekForTests(fixedDek());
    secretsPut(apiKeyAccount("anthropic"), "sk-ant-secret-12345");
    expect(secretsGet(apiKeyAccount("anthropic"))).toBe("sk-ant-secret-12345");
  });

  it("returns null for a never-written account", () => {
    vault.__setDekForTests(fixedDek());
    expect(secretsGet(apiKeyAccount("google"))).toBeNull();
  });

  it("delete removes the entry and returns true only when something existed", () => {
    vault.__setDekForTests(fixedDek());
    expect(secretsDelete(apiKeyAccount("kimi"))).toBe(false);
    secretsPut(apiKeyAccount("kimi"), "sk-kimi-abc");
    expect(secretsDelete(apiKeyAccount("kimi"))).toBe(true);
    expect(secretsGet(apiKeyAccount("kimi"))).toBeNull();
  });

  it("falls back to plaintext passthrough when the vault isn't ready", () => {
    // initVault never called — dek null.
    secretsPut(apiKeyAccount("qwen"), "sk-qwen-plain");
    const raw = localStorage.getItem("socratic-council-secret:apiKey:qwen");
    expect(raw).toBe("sk-qwen-plain"); // no ENC1 envelope
    expect(secretsGet(apiKeyAccount("qwen"))).toBe("sk-qwen-plain");
  });

  it("gracefully returns null when a ciphertext can't be decrypted", () => {
    vault.__setDekForTests(fixedDek());
    localStorage.setItem(
      "socratic-council-secret:apiKey:zhipu",
      "ENC1:bm90LXJlYWwtY2lwaGVydGV4dA==",
    );
    expect(secretsGet(apiKeyAccount("zhipu"))).toBeNull();
  });

  it("isKeychainAvailable remains true for API compatibility", () => {
    expect(isKeychainAvailable()).toBe(true);
  });

  it("rejects empty account names", () => {
    expect(() => secretsGet("")).toThrow();
    expect(() => secretsPut("   ", "x")).toThrow();
    expect(() => secretsDelete("")).toThrow();
  });
});
