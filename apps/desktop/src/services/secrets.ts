/**
 * Thin wrapper over the Rust `secrets_*` commands.
 *
 * Stores platform-protected secrets (API keys, proxy passwords, vault data-
 * encryption key) in the OS credential store via the `keyring` crate.
 * Mirrors the dynamic-import pattern used in `tauriTransport.ts` so the
 * module is safe to load in non-Tauri contexts (tests, web builds) even
 * though calls will fail there.
 *
 * Account naming convention:
 *   - `apiKey:openai`, `apiKey:anthropic`, … — provider API keys
 *   - `proxy:password`                        — global proxy password (1.2 follow-up)
 *   - `vault:dek`                             — data-encryption key for at-rest
 *                                               session/attachment encryption (1.2)
 *
 * Never log the returned value. Callers are expected to hold the secret only
 * for the duration of the operation that needs it.
 */

function isTauri(): boolean {
  return (
    typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`secrets service: Tauri environment required for ${command}`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke(command, args)) as T;
}

export async function secretsPut(account: string, value: string): Promise<void> {
  if (!account || account.trim() === "") throw new Error("secretsPut: account required");
  if (!value) throw new Error("secretsPut: value required");
  await invokeTauri<void>("secrets_put", { account, value });
}

export async function secretsGet(account: string): Promise<string | null> {
  if (!account || account.trim() === "") throw new Error("secretsGet: account required");
  const result = await invokeTauri<string | null>("secrets_get", { account });
  return result ?? null;
}

export async function secretsDelete(account: string): Promise<boolean> {
  if (!account || account.trim() === "") throw new Error("secretsDelete: account required");
  return await invokeTauri<boolean>("secrets_delete", { account });
}

export function apiKeyAccount(provider: string): string {
  return `apiKey:${provider}`;
}

/** Whether the current environment can persist secrets via the OS keychain. */
export function isKeychainAvailable(): boolean {
  return isTauri();
}
