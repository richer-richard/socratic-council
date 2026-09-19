/**
 * Session sync — the desktop half of the shared session store.
 *
 * The CLI and the app keep one encrypted file per session under the app's
 * data directory (`sessions/<id>.json`, an `ENC1:` envelope sealed with the
 * same file DEK the vault uses). This module:
 *   - exports every saved session there (debounced per id), so the terminal
 *     sees the app's history;
 *   - imports sessions the CLI wrote (or updated) at boot and on window focus,
 *     so the app sees terminal debates and can open / continue them.
 * Last writer wins by `updatedAt`; the app only ever overwrites a session it
 * itself saved. Everything is best-effort and a no-op outside Tauri.
 */

import {
  importDiscussionSession,
  listSessionSummaries,
  loadDiscussionSession,
  registerSessionHooks,
  type DiscussionSession,
} from "./sessions";
import { decryptString, encryptString, isVaultReady } from "./vault";

const SEEN_PREFIX = "socratic-council-sync-seen:";
const EXPORT_DEBOUNCE_MS = 750;

interface SharedEntry {
  id: string;
  modified_ms: number;
}

function isTauri(): boolean {
  return (
    typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function seen(id: string): number {
  const raw = storage()?.getItem(SEEN_PREFIX + id);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

function markSeen(id: string, modifiedMs: number): void {
  try {
    storage()?.setItem(SEEN_PREFIX + id, String(modifiedMs));
  } catch {
    // storage full / unavailable — worst case we re-read the file next time
  }
}

const pendingExports = new Map<string, ReturnType<typeof setTimeout>>();

/** Seal + write one session to the shared store (debounced per id). */
export function scheduleSessionExport(session: DiscussionSession): void {
  if (!isTauri() || !isVaultReady()) return;
  const existing = pendingExports.get(session.id);
  if (existing) clearTimeout(existing);
  pendingExports.set(
    session.id,
    setTimeout(() => {
      pendingExports.delete(session.id);
      void exportSessionNow(session);
    }, EXPORT_DEBOUNCE_MS),
  );
}

export async function exportSessionNow(session: DiscussionSession): Promise<boolean> {
  if (!isTauri() || !isVaultReady()) return false;
  try {
    const envelope = encryptString(JSON.stringify({ ...session, origin: "app" }));
    await invoke("session_sync_write", { id: session.id, envelope });
    markSeen(session.id, Date.now());
    return true;
  } catch (error) {
    console.warn("[sessionSync] export failed:", session.id, error);
    return false;
  }
}

export async function deleteSharedSession(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("session_sync_delete", { id });
  } catch (error) {
    console.warn("[sessionSync] delete failed:", id, error);
  }
}

/**
 * Pull sessions the other surface wrote. Returns how many were imported and
 * how many local-only sessions were pushed to the shared store.
 */
export async function importSharedSessions(): Promise<{ imported: number; exported: number }> {
  const result = { imported: 0, exported: 0 };
  if (!isTauri() || !isVaultReady()) return result;

  let entries: SharedEntry[];
  try {
    entries = await invoke<SharedEntry[]>("session_sync_list");
  } catch (error) {
    console.warn("[sessionSync] list failed:", error);
    return result;
  }

  const local = new Map(listSessionSummaries().map((s) => [s.id, s]));
  const sharedIds = new Set(entries.map((e) => e.id));

  for (const entry of entries) {
    if (entry.modified_ms <= seen(entry.id)) continue; // unchanged since last look
    try {
      const envelope = await invoke<string | null>("session_sync_read", { id: entry.id });
      if (!envelope) continue;
      const parsed = JSON.parse(decryptString(envelope)) as { updatedAt?: number };
      const ours = local.get(entry.id);
      // Only take it when it is newer than what we hold (or new to us).
      if (!ours || (parsed.updatedAt ?? 0) > ours.updatedAt) {
        if (importDiscussionSession(parsed)) result.imported += 1;
      }
      markSeen(entry.id, entry.modified_ms);
    } catch (error) {
      console.warn("[sessionSync] import failed:", entry.id, error);
    }
  }

  // Sessions that exist only in the app (created before sync, or while the
  // store was unavailable) go out so the terminal can see them too.
  for (const summary of local.values()) {
    if (sharedIds.has(summary.id) || summary.loadError) continue;
    const session = loadDiscussionSession(summary.id);
    if (session && (await exportSessionNow(session))) result.exported += 1;
  }

  return result;
}

// Wire the hooks once: every local save schedules an export, every delete
// removes the shared file.
registerSessionHooks({
  onSaved: scheduleSessionExport,
  onDeleted: (id) => void deleteSharedSession(id),
});
