/**
 * Moving the app's data out of the old App Sandbox container
 * (`src-tauri/src/data_move.rs`). The backend copies the data before the
 * window opens. Only the front end can tell whether WebKit then reads the
 * copied storage, so it looks once, before any of its own code writes a key,
 * and reports what it saw.
 */

const APP_KEYS = ["socratic-council-config", "socratic-council-session-index-v1"];
const SECRET_PREFIX = "socratic-council-secret:";

/** Whether localStorage holds anything the app itself stored before this boot. */
export function holdsAppStorage(keys: readonly string[]): boolean {
  return keys.some((k) => APP_KEYS.includes(k) || k.startsWith(SECRET_PREFIX));
}

function storedKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key) out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Taken when this module is first evaluated. `main.tsx` imports it before
 * anything else, so no boot code has written a key yet.
 */
const FOUND_AT_BOOT = typeof window !== "undefined" && holdsAppStorage(storedKeys());

export type MoveConfirmation = "confirmed" | "unread" | "not_needed";

/** Tell the backend what WebKit showed at boot. Outside Tauri nothing waits. */
export async function confirmDataMove(): Promise<MoveConfirmation> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<MoveConfirmation>("app_data_move_confirm", { found: FOUND_AT_BOOT });
  } catch {
    return "not_needed";
  }
}

export interface MoveStatus {
  state: string;
  reason: string | null;
  container: string | null;
}

export async function dataMoveStatus(): Promise<MoveStatus | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<MoveStatus>("app_data_move_status");
  } catch {
    return null;
  }
}

/**
 * The failure screen's text when the vault stays closed because the data has
 * not been copied out yet, or `null` when that is not why it is closed.
 */
export function blockedMessage(status: MoveStatus | null): string | null {
  if (!status || (status.state !== "failed" && status.state !== "pending")) return null;
  const where = status.container ? ` It is all still in ${status.container}.` : "";
  const why = status.reason ? ` ${status.reason}` : "";
  return (
    `This version keeps its data outside the old app container, and moving it has not finished.${why}` +
    ` Nothing was deleted.${where} Quit Socratic Council and open it again to try once more.`
  );
}

/** The notice when the copy landed but WebKit showed none of it. */
export function unreadMessage(container: string | null): string {
  const where = container ?? "the old app container";
  return (
    `Your keys, settings and session list did not come across from the old app container.` +
    ` They are still in ${where}. Sessions saved to disk will appear again as the app syncs.`
  );
}
