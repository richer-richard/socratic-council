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
    expect(vault.getVaultStatus()).toBe("uninitialized");
  });

  it("detects the envelope prefix", () => {
    expect(vault.isEnvelopedCiphertext("ENC1:abc")).toBe(true);
    expect(vault.isEnvelopedCiphertext("plain text")).toBe(false);
    expect(vault.isEnvelopedCiphertext("")).toBe(false);
  });

  it("round-trips string plaintext once a DEK is injected", () => {
    vault.__setDekForTests(fixedDek(7));
    expect(vault.isVaultReady()).toBe(true);
    expect(vault.getVaultStatus()).toBe("existing");

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

  it("counts decrypt failures so callers can detect wrong-DEK state (fix 2.2)", () => {
    vault.__setDekForTests(fixedDek(13));
    expect(vault.getDecryptFailureCount()).toBe(0);

    // Forge a ciphertext encrypted under a different DEK.
    vault.__setDekForTests(fixedDek(99));
    const ciphertext = vault.encryptString("hello world");

    // Switch to a different DEK and try to decrypt — must throw, must count.
    vault.__setDekForTests(fixedDek(13));
    expect(() => vault.decryptString(ciphertext)).toThrow();
    expect(vault.getDecryptFailureCount()).toBe(1);

    // Bytes path increments the counter independently.
    const bytes = new Uint8Array(48);
    bytes.set([1, 2, 3, 4]);
    expect(() => vault.decryptBytes(bytes)).toThrow();
    expect(vault.getDecryptFailureCount()).toBe(2);
  });

  it("setDekForTests resets the failure counter", () => {
    vault.__setDekForTests(fixedDek(5));
    expect(() => vault.decryptString("ENC1:not-real")).toThrow();
    expect(vault.getDecryptFailureCount()).toBe(1);

    vault.__setDekForTests(fixedDek(6));
    expect(vault.getDecryptFailureCount()).toBe(0);
  });
});
