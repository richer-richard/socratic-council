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
 * once at app boot before calling any of them.
 *
 * Refusing the plaintext fallback for secrets (fix 1.2):
 *   The vault module's `encryptString` returns the input unchanged when the
 *   DEK isn't loaded — that policy makes sense for session content where
 *   data loss is the worst outcome. For high-value secrets (API keys,
 *   proxy passwords), silently writing plaintext to disk is the worst
 *   outcome. `secretsPut` therefore THROWS rather than fall back, and
 *   callers must check `isSecretStoreReady()` first.
 *
 * Size cap (fix 1.9):
 *   The store rejects values larger than `MAX_SECRET_VALUE_BYTES` to
 *   prevent an upstream bug from silently consuming localStorage quota
 *   under the secret prefix.
 *
 * Never log the returned value. Callers are expected to hold the secret
 * only for the duration of the operation that needs it.
 */

import { decryptString, encryptString, isEnvelopedCiphertext, isVaultReady } from "./vault";

const SECRET_STORAGE_PREFIX = "socratic-council-secret:";

/**
 * Hard cap on a single secret value. API keys are typically < 200 bytes,
 * proxy passwords similar; 64 KiB is a generous ceiling that catches
 * runaway-blob bugs without rejecting any plausible legitimate use.
 */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;

export class SecretStoreError extends Error {
  readonly code: "vault_not_ready" | "value_too_large" | "invalid_account";

  constructor(
    code: "vault_not_ready" | "value_too_large" | "invalid_account",
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

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

function assertAccount(name: string, label: string): void {
  if (!name || name.trim() === "") {
    throw new SecretStoreError("invalid_account", `${label}: account required`);
  }
}

/**
 * Write a secret. THROWS if the vault isn't ready — secrets are too
 * sensitive to fall back to plaintext storage (see fix 1.2). Callers
 * should await `initVault()` and check `isSecretStoreReady()` before
 * exposing a "save key" UI surface.
 */
export function secretsPut(account: string, value: string): void {
  assertAccount(account, "secretsPut");
  if (!value) {
    throw new SecretStoreError("invalid_account", "secretsPut: value required");
  }

  // Compute UTF-8 byte length without allocating a full encoded array
  // unless we actually need to. This catches the case where a JS string
  // containing astral / CJK / emoji characters is larger than its
  // `.length` would suggest.
  const utf8 = new TextEncoder().encode(value);
  if (utf8.length > MAX_SECRET_VALUE_BYTES) {
    throw new SecretStoreError(
      "value_too_large",
      `secretsPut: value exceeds ${MAX_SECRET_VALUE_BYTES}-byte limit (got ${utf8.length})`,
    );
  }

  if (!isVaultReady()) {
    throw new SecretStoreError(
      "vault_not_ready",
      "secretsPut: vault is not ready; refusing to store the secret as plaintext",
    );
  }

  const storage = getStorage();
  if (!storage) return;
  storage.setItem(storageKeyFor(account), encryptString(value));
}

/**
 * Read a secret. Returns null when:
 *   - The account was never written.
 *   - The stored value is non-enveloped legacy plaintext from a previous
 *     build (returned as-is so a one-time migration step can pick it up).
 *   - The stored value is enveloped but failed to decrypt.
 *
 * Decrypt failures are visible via `vault.getDecryptFailureCount()` so
 * the UI can detect a wrong-DEK situation and surface a recovery banner.
 */
export function secretsGet(account: string): string | null {
  assertAccount(account, "secretsGet");
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
  assertAccount(account, "secretsDelete");
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
 * DEK has been loaded. UI should disable "save key" surfaces until this
 * returns true so users can't accidentally trigger the SecretStoreError.
 */
export function isSecretStoreReady(): boolean {
  return isVaultReady();
}
