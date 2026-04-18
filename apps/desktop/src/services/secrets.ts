/**
 * Secret storage — encrypted values in localStorage, keyed by `account` name.
 *
 * Replaces the previous OS-keychain-backed implementation that prompted the
 * user for their login password on every read/write (because ad-hoc code
 * signatures can't maintain a stable keychain ACL identity). Everything now
 * rides the same XChaCha20-Poly1305 vault that already protects sessions
 * and attachments — one unified at-rest encryption, zero prompts.
 *
 * Account naming convention:
 *   - `apiKey:openai`, `apiKey:anthropic`, … — provider API keys
 *   - `proxy:password`                        — global proxy password
 *
 * All three functions are synchronous. Callers must `await initVault()`
 * once at app boot before calling any of them; if the vault isn't ready,
 * writes pass through as plaintext (so data isn't lost) and reads return
 * null.
 *
 * Never log the returned value. Callers are expected to hold the secret
 * only for the duration of the operation that needs it.
 */

import { decryptString, encryptString, isEnvelopedCiphertext, isVaultReady } from "./vault";

const SECRET_STORAGE_PREFIX = "socratic-council-secret:";

function storageKeyFor(account: string): string {
  return `${SECRET_STORAGE_PREFIX}${account}`;
}

function getStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof globalThis !== "undefined") {
    const g = globalThis as { localStorage?: Storage };
    if (g.localStorage) return g.localStorage;
  }
  return null;
}

export function secretsPut(account: string, value: string): void {
  if (!account || account.trim() === "") throw new Error("secretsPut: account required");
  if (!value) throw new Error("secretsPut: value required");
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(storageKeyFor(account), encryptString(value));
}

export function secretsGet(account: string): string | null {
  if (!account || account.trim() === "") throw new Error("secretsGet: account required");
  const storage = getStorage();
  if (!storage) return null;
  const raw = storage.getItem(storageKeyFor(account));
  if (raw == null) return null;
  if (!isEnvelopedCiphertext(raw)) return raw; // legacy plaintext
  try {
    return decryptString(raw);
  } catch (error) {
    console.error(`[secrets] Failed to decrypt "${account}":`, error);
    return null;
  }
}

export function secretsDelete(account: string): boolean {
  if (!account || account.trim() === "") throw new Error("secretsDelete: account required");
  const storage = getStorage();
  if (!storage) return false;
  const key = storageKeyFor(account);
  if (storage.getItem(key) == null) return false;
  storage.removeItem(key);
  return true;
}

export function apiKeyAccount(provider: string): string {
  return `apiKey:${provider}`;
}

/**
 * Whether the secret store is ready for reads/writes. True once the vault
 * DEK has been loaded. Prior to that, writes will be stored in plaintext
 * (preserving data) and reads will succeed for plaintext legacy entries.
 */
export function isSecretStoreReady(): boolean {
  return isVaultReady();
}

/**
 * Kept for API compatibility with the old keychain-backed module. Always
 * returns true now because the store is localStorage-backed and works on
 * every platform the app runs on (including non-Tauri dev-web contexts).
 */
export function isKeychainAvailable(): boolean {
  return true;
}
