import { describe, expect, it } from "vitest";

import { BARE_SHELL_HINT, SHELL_HINT, UNSANDBOXED_HINT, shellControls } from "./shellControls";

const on = { enabled: true, unsandboxed: true, timeout_secs: 30, max_output_bytes: 16384 };
const off = { ...on, enabled: false };

describe("shellControls", () => {
  it("shows the shell as off and explains why in the installed app", () => {
    const blocked = { available: false, sandbox: null, reason: "Run it from the terminal." };
    expect(shellControls(blocked, on)).toEqual({
      checked: false,
      disabled: true,
      hint: "Run it from the terminal.",
      showOptions: false,
      showUnsandboxed: false,
    });
  });

  it("never offers a bare shell where a sandbox exists", () => {
    const sandboxed = { available: true, sandbox: "macos", reason: null };
    const c = shellControls(sandboxed, on);
    expect(c).toMatchObject({ checked: true, disabled: false, showOptions: true });
    expect(c.showUnsandboxed).toBe(false);
    expect(c.hint).toBe(SHELL_HINT);
  });

  it("offers the opt-in only where no sandbox exists, and only while the shell is on", () => {
    const bare = { available: true, sandbox: null, reason: null };
    expect(shellControls(bare, on)).toMatchObject({ showUnsandboxed: true, hint: BARE_SHELL_HINT });
    expect(shellControls(bare, off).showUnsandboxed).toBe(false);
  });

  it("shows the stored policy as is outside Tauri", () => {
    expect(shellControls(null, on)).toMatchObject({
      checked: true,
      disabled: false,
      showUnsandboxed: false,
    });
  });

  it("keeps the visible copy free of semicolons and dashes", () => {
    for (const text of [SHELL_HINT, BARE_SHELL_HINT, UNSANDBOXED_HINT]) {
      expect(text).not.toMatch(/[;—–]/);
    }
  });
});
