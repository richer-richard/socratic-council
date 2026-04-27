/**
 * Cross-platform "save a file" helpers used by the ArgumentMap export
 * popover. Tauri's webview honors anchor downloads so we don't need the
 * dialog plugin — same pattern the BundleExportButton uses.
 */

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  triggerAnchorDownload(filename, blob);
}

export function downloadBytes(filename: string, blob: Blob): void {
  triggerAnchorDownload(filename, blob);
}

function triggerAnchorDownload(filename: string, blob: Blob): void {
  if (typeof document === "undefined") return; // SSR / non-DOM env
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
