import { describe, it, expect, afterEach, vi } from "vitest";

import * as vault from "./vault";

// Unit-test the vault without Tauri — we inject the DEK by reaching into the
// non-Tauri fallback path (isTauri=false → initVault skips, leaves DEK null).
// These tests patch the internal helpers to simulate a loaded DEK.

describe("vault ciphertext envelope", () => {
  afterEach(() => {
    vault.__resetVaultForTests();
    vi.restoreAllMocks();
  });

  it("leaves non-enveloped values unchanged when vault isn't ready", () => {
    // No init — DEK null. encryptString should pass through.
    expect(vault.encryptString("hello")).toBe("hello");
    expect(vault.isEnvelopedCiphertext("hello")).toBe(false);
  });

  it("detects the envelope prefix", () => {
    expect(vault.isEnvelopedCiphertext("ENC1:abc")).toBe(true);
    expect(vault.isEnvelopedCiphertext("plain text")).toBe(false);
    expect(vault.isEnvelopedCiphertext("")).toBe(false);
  });

  it("round-trips string plaintext once a DEK is loaded", async () => {
    // Simulate a keychain-backed DEK by stubbing the secrets module.
    const secrets = await import("./secrets");
    const dekBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) dekBytes[i] = (i * 7 + 1) & 0xff;
    const b64 =
      typeof btoa === "function"
        ? btoa(String.fromCharCode(...dekBytes))
        : Buffer.from(dekBytes).toString("base64");

    vi.spyOn(secrets, "isKeychainAvailable").mockReturnValue(true);
    vi.spyOn(secrets, "secretsGet").mockResolvedValue(b64);
    vi.spyOn(secrets, "secretsPut").mockResolvedValue(undefined);

    await vault.initVault();
    expect(vault.isVaultReady()).toBe(true);

    const plaintext = "transcript with sensitive content: sk-fake-key-value";
    const encrypted = vault.encryptString(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(vault.isEnvelopedCiphertext(encrypted)).toBe(true);

    const decrypted = vault.decryptString(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips byte buffers", async () => {
    const secrets = await import("./secrets");
    const dekBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) dekBytes[i] = (i * 11 + 3) & 0xff;
    const b64 =
      typeof btoa === "function"
        ? btoa(String.fromCharCode(...dekBytes))
        : Buffer.from(dekBytes).toString("base64");

    vi.spyOn(secrets, "isKeychainAvailable").mockReturnValue(true);
    vi.spyOn(secrets, "secretsGet").mockResolvedValue(b64);
    vi.spyOn(secrets, "secretsPut").mockResolvedValue(undefined);

    await vault.initVault();

    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    const cipher = vault.encryptBytes(bytes);
    expect(cipher.length).toBeGreaterThan(bytes.length); // includes nonce + tag

    const plain = vault.decryptBytes(cipher);
    expect(Array.from(plain)).toEqual(Array.from(bytes));
  });

  it("rejects malformed ciphertext during decrypt", async () => {
    const secrets = await import("./secrets");
    const dekBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) dekBytes[i] = 1;
    const b64 =
      typeof btoa === "function"
        ? btoa(String.fromCharCode(...dekBytes))
        : Buffer.from(dekBytes).toString("base64");

    vi.spyOn(secrets, "isKeychainAvailable").mockReturnValue(true);
    vi.spyOn(secrets, "secretsGet").mockResolvedValue(b64);
    vi.spyOn(secrets, "secretsPut").mockResolvedValue(undefined);

    await vault.initVault();

    // Too short to contain nonce + tag
    expect(() => vault.decryptBytes(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => vault.decryptString("ENC1:YQ==")).toThrow(); // tiny malformed envelope
  });
});
