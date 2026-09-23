/**
 * Closing the app from a command. Closing the only window ends a Tauri app,
 * so `/quit` closes the window (the `core:window:allow-close` permission). In
 * a plain browser (the dev server) there is no app to quit, so it says so.
 */
export async function quitApp(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return true;
  } catch {
    return false;
  }
}
