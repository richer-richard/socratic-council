import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SECRET_VALUE_BYTES,
  SecretStoreError,
  apiKeyAccount,
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

  it("THROWS when the vault isn't ready instead of writing plaintext (fix 1.2)", () => {
    // initVault never called — dek null.
    expect(() => secretsPut(apiKeyAccount("qwen"), "sk-qwen-plain"))
      .toThrowError(SecretStoreError);
    expect(localStorage.getItem("socratic-council-secret:apiKey:qwen")).toBeNull();
  });

  it("returns plaintext for legacy values from earlier builds (read path is permissive)", () => {
    // Plant a legacy plaintext entry as if migrated from an older app version.
    localStorage.setItem("socratic-council-secret:apiKey:qwen", "sk-qwen-plain");
    vault.__setDekForTests(fixedDek());
    expect(secretsGet(apiKeyAccount("qwen"))).toBe("sk-qwen-plain");
  });

  it("re-encrypts legacy plaintext on the next save (fix 1.10)", () => {
    // Vault not ready, plaintext written by a legacy build.
    localStorage.setItem("socratic-council-secret:apiKey:legacy", "sk-legacy-12345");
    expect(localStorage.getItem("socratic-council-secret:apiKey:legacy")).toBe("sk-legacy-12345");

    // Vault becomes ready, caller saves the secret again (the value can be
    // the same string — what matters is that the save now encrypts it).
    vault.__setDekForTests(fixedDek());
    expect(isSecretStoreReady()).toBe(true);
    secretsPut(apiKeyAccount("legacy"), "sk-legacy-12345");

    const raw = localStorage.getItem("socratic-council-secret:apiKey:legacy");
    expect(raw).not.toBeNull();
    expect(raw!.startsWith("ENC1:")).toBe(true);
    expect(secretsGet(apiKeyAccount("legacy"))).toBe("sk-legacy-12345");
  });

  it("gracefully returns null when a ciphertext can't be decrypted", () => {
    vault.__setDekForTests(fixedDek());
    localStorage.setItem(
      "socratic-council-secret:apiKey:zhipu",
      "ENC1:bm90LXJlYWwtY2lwaGVydGV4dA==",
    );
    expect(secretsGet(apiKeyAccount("zhipu"))).toBeNull();
    // Decrypt failure should be observable from the vault module so the UI
    // can detect a wrong-DEK situation (fix 2.2 / 2.3 surface).
    expect(vault.getDecryptFailureCount()).toBeGreaterThan(0);
  });

  it("rejects values larger than MAX_SECRET_VALUE_BYTES (fix 1.9)", () => {
    vault.__setDekForTests(fixedDek());
    const oversize = "a".repeat(MAX_SECRET_VALUE_BYTES + 1);
    expect(() => secretsPut(apiKeyAccount("openai"), oversize))
      .toThrowError(/exceeds.*byte limit/);
    // A value just at the limit should be accepted.
    const atLimit = "b".repeat(MAX_SECRET_VALUE_BYTES);
    secretsPut(apiKeyAccount("openai"), atLimit);
    expect(secretsGet(apiKeyAccount("openai"))).toBe(atLimit);
  });

  it("rejects empty account names", () => {
    expect(() => secretsGet("")).toThrow();
    expect(() => secretsPut("   ", "x")).toThrow();
    expect(() => secretsDelete("")).toThrow();
  });
});
