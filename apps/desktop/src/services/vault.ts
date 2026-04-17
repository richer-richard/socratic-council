/**
 * Local encryption vault — protects session data and attachments at rest.
 *
 * Design:
 *   1. A 32-byte data-encryption key (DEK) is generated once per install and
 *      stored in the OS keychain under account `vault:dek`.
 *   2. Encryption uses XChaCha20-Poly1305 via @noble/ciphers (audited, sync,
 *      zero-dep). Each ciphertext carries a fresh 24-byte nonce.
 *   3. `initVault()` must run (async) before any encrypt/decrypt call. It
 *      loads the DEK from the keychain — or creates one on first run.
 *   4. Ciphertexts are wrapped with an ASCII header so loaders can tell them
 *      apart from legacy plaintext and from future versioned formats:
 *        `ENC1:<base64(nonce || ciphertext || tag)>`
 *
 * This keeps the existing synchronous storage API intact (sessions.ts stays
 * synchronous) while moving transcripts, attachments, and other local state
 * off the disk in plaintext.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { isKeychainAvailable, secretsGet, secretsPut } from "./secrets";

const VAULT_ACCOUNT = "vault:dek";
const CIPHERTEXT_PREFIX = "ENC1:";
const NONCE_BYTES = 24;

let dek: Uint8Array | null = null;
let initPromise: Promise<void> | null = null;

/** Base-64 encode a byte array (no dependency on Node Buffer). */
function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

/** Base-64 decode. */
function b64decode(text: string): Uint8Array {
  const binary = typeof atob === "function" ? atob(text) : Buffer.from(text, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(out);
  } else {
    // This path should only ever run in Node-test contexts where webcrypto is absent.
    // Throw to avoid silently using a weak RNG.
    throw new Error("vault: no secure random source available");
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Load the DEK from the keychain, or generate + store one on first run.
 * Idempotent and safe to call repeatedly. Callers should await this once at
 * app boot before touching persisted sessions/attachments.
 */
export async function initVault(): Promise<void> {
  if (dek) return;
  if (!isKeychainAvailable()) {
    // Non-Tauri environment (tests, dev-web): skip vault; all read/write
    // paths fall back to plaintext.
    return;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const stored = await secretsGet(VAULT_ACCOUNT);
      if (stored && stored.trim() !== "") {
        const bytes = b64decode(stored.trim());
        if (bytes.length === 32) {
          dek = bytes;
          return;
        }
      }

      // First run — generate a DEK and persist.
      const fresh = randomBytes(32);
      await secretsPut(VAULT_ACCOUNT, b64encode(fresh));
      dek = fresh;
    } catch (error) {
      console.error("[vault] initVault failed:", error);
      // Leave dek null; callers fall back to plaintext.
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/** Whether the vault has an active DEK and can encrypt/decrypt. */
export function isVaultReady(): boolean {
  return dek !== null;
}

/** Whether a value looks like our ciphertext envelope. */
export function isEnvelopedCiphertext(value: string): boolean {
  return typeof value === "string" && value.startsWith(CIPHERTEXT_PREFIX);
}

/**
 * Encrypt a UTF-8 string. If the vault isn't ready, returns the plaintext
 * unchanged so callers never lose data — an unencrypted value will be
 * re-written in encrypted form on the next save after `initVault()` runs.
 */
export function encryptString(plaintext: string): string {
  if (!dek) return plaintext;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = xchacha20poly1305(dek, nonce);
  const cipherBytes = cipher.encrypt(textEncoder.encode(plaintext));
  const combined = new Uint8Array(nonce.length + cipherBytes.length);
  combined.set(nonce, 0);
  combined.set(cipherBytes, nonce.length);
  return CIPHERTEXT_PREFIX + b64encode(combined);
}

/**
 * Decrypt an enveloped ciphertext back to its UTF-8 string. Non-enveloped
 * inputs (legacy plaintext stored before encryption was added) are returned
 * unchanged. Throws if the envelope is malformed or authentication fails.
 */
export function decryptString(value: string): string {
  if (!isEnvelopedCiphertext(value)) return value;
  if (!dek) {
    throw new Error("vault: cannot decrypt, DEK not loaded (call initVault first)");
  }
  const payload = b64decode(value.slice(CIPHERTEXT_PREFIX.length));
  if (payload.length < NONCE_BYTES + 16) {
    throw new Error("vault: ciphertext too short");
  }
  const nonce = payload.subarray(0, NONCE_BYTES);
  const body = payload.subarray(NONCE_BYTES);
  const cipher = xchacha20poly1305(dek, nonce);
  const plaintext = cipher.decrypt(body);
  return textDecoder.decode(plaintext);
}

/**
 * Encrypt a raw byte buffer. Returns `nonce || ciphertext || tag`. If the
 * vault isn't ready, returns the input unchanged so binary data isn't lost
 * during the pre-init window.
 */
export function encryptBytes(plaintext: Uint8Array): Uint8Array {
  if (!dek) return plaintext;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = xchacha20poly1305(dek, nonce);
  const cipherBytes = cipher.encrypt(plaintext);
  const combined = new Uint8Array(nonce.length + cipherBytes.length);
  combined.set(nonce, 0);
  combined.set(cipherBytes, nonce.length);
  return combined;
}

/**
 * Decrypt bytes produced by `encryptBytes`. Expects `nonce || ciphertext || tag`.
 * Throws if the vault isn't ready or if the tag fails authentication.
 */
export function decryptBytes(ciphertext: Uint8Array): Uint8Array {
  if (!dek) {
    throw new Error("vault: cannot decrypt, DEK not loaded (call initVault first)");
  }
  if (ciphertext.length < NONCE_BYTES + 16) {
    throw new Error("vault: byte ciphertext too short");
  }
  const nonce = ciphertext.subarray(0, NONCE_BYTES);
  const body = ciphertext.subarray(NONCE_BYTES);
  const cipher = xchacha20poly1305(dek, nonce);
  return cipher.decrypt(body);
}

/** Exposed for tests only. */
export function __resetVaultForTests(): void {
  dek = null;
  initPromise = null;
}
