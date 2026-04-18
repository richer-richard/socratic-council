/**
 * Local encryption vault — protects session data, attachments, and secrets
 * (API keys, etc.) at rest. Zero password prompts.
 *
 * Design:
 *   1. A 32-byte data-encryption key (DEK) lives in a file under the app's
 *      data directory (`~/Library/Application Support/.../vault.key` on
 *      macOS) with 0600 permissions. Managed by the Rust `vault_get_dek`
 *      command — see `src-tauri/src/vault_file.rs`.
 *   2. Encryption uses XChaCha20-Poly1305 via @noble/ciphers (audited, sync,
 *      zero-dep). Each ciphertext carries a fresh 24-byte nonce.
 *   3. `initVault()` runs once at app boot, fetches the DEK via IPC, and
 *      holds it in module-level state. Encryption/decryption thereafter
 *      is synchronous — no further IPC, no OS prompts.
 *   4. Ciphertexts are wrapped with an ASCII header so loaders can
 *      distinguish them from legacy plaintext:
 *        `ENC1:<base64(nonce || ciphertext || tag)>`
 *
 * Previous design (deleted): used the `keyring` crate to fetch the DEK
 * from the OS keychain. On ad-hoc signed / unsigned macOS builds this
 * triggered a login-password prompt on every read because keychain ACLs
 * bind to a stable code signing identity the build didn't have. The
 * file-based approach sidesteps the identity requirement entirely.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

const CIPHERTEXT_PREFIX = "ENC1:";
const NONCE_BYTES = 24;
const DEK_LEN = 32;

let dek: Uint8Array | null = null;
let initPromise: Promise<void> | null = null;

function isTauri(): boolean {
  return (
    typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

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
    throw new Error("vault: no secure random source available");
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Fetch (or create on first run) the DEK from the Rust-managed vault file
 * and cache it in module state. Idempotent and safe to call repeatedly.
 * Callers must await this once at app boot before touching persisted data.
 */
export async function initVault(): Promise<void> {
  if (dek) return;
  if (!isTauri()) {
    // Non-Tauri environment (tests, dev-web): no DEK available.
    // Callers that try to encrypt will pass plaintext through unchanged.
    return;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = await invoke<number[]>("vault_get_dek");
      if (!Array.isArray(bytes) || bytes.length !== DEK_LEN) {
        throw new Error(`vault_get_dek returned unexpected payload (length ${bytes?.length})`);
      }
      dek = Uint8Array.from(bytes);
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

/**
 * Inject a DEK manually — for tests and dev-web environments. Production
 * code should call `initVault()` which goes through the Rust file store.
 */
export function __setDekForTests(bytes: Uint8Array | null): void {
  dek = bytes;
  initPromise = null;
}

/** Exposed for tests only. */
export function __resetVaultForTests(): void {
  dek = null;
  initPromise = null;
}
