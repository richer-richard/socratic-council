import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as vault from "./vault";

// These tests exercise the pure encrypt/decrypt path by injecting a DEK
// directly via the test hook (the real Rust-backed `initVault` is only
// reachable inside a Tauri runtime).

function fixedDek(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (i * seed + 1) & 0xff;
  return out;
}

describe("vault ciphertext envelope", () => {
  beforeEach(() => {
    vault.__resetVaultForTests();
  });
  afterEach(() => {
    vault.__resetVaultForTests();
  });

  it("leaves non-enveloped values unchanged when vault isn't ready", () => {
    expect(vault.encryptString("hello")).toBe("hello");
    expect(vault.isEnvelopedCiphertext("hello")).toBe(false);
    expect(vault.isVaultReady()).toBe(false);
  });

  it("detects the envelope prefix", () => {
    expect(vault.isEnvelopedCiphertext("ENC1:abc")).toBe(true);
    expect(vault.isEnvelopedCiphertext("plain text")).toBe(false);
    expect(vault.isEnvelopedCiphertext("")).toBe(false);
  });

  it("round-trips string plaintext once a DEK is injected", () => {
    vault.__setDekForTests(fixedDek(7));
    expect(vault.isVaultReady()).toBe(true);

    const plaintext = "transcript with sensitive content: sk-fake-key-value";
    const encrypted = vault.encryptString(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(vault.isEnvelopedCiphertext(encrypted)).toBe(true);

    const decrypted = vault.decryptString(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips byte buffers", () => {
    vault.__setDekForTests(fixedDek(11));

    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const cipher = vault.encryptBytes(bytes);
    expect(cipher.length).toBeGreaterThan(bytes.length); // includes nonce + tag

    const plain = vault.decryptBytes(cipher);
    expect(Array.from(plain)).toEqual(Array.from(bytes));
  });

  it("rejects malformed ciphertext during decrypt", () => {
    vault.__setDekForTests(fixedDek(1));

    // Too short to contain nonce + tag
    expect(() => vault.decryptBytes(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => vault.decryptString("ENC1:YQ==")).toThrow(); // tiny malformed envelope
  });
});
