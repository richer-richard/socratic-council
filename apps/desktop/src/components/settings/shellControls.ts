/**
 * How the Tools card draws the shell row for what this build can do. Kept
 * apart from the card so the rules are testable without a DOM.
 */

import type { EngineToolPolicy } from "@socratic-council/shared";

import type { ShellSupport } from "../../services/engine";

export interface ShellControls {
  /** The toggle's state as shown: never on where the shell cannot run. */
  checked: boolean;
  disabled: boolean;
  hint: string;
  /** Timeout and output cap, only while the shell is on and can run. */
  showOptions: boolean;
  /** The opt-in to a bare shell, only where no sandbox exists. */
  showUnsandboxed: boolean;
}

export const SHELL_HINT =
  "Run commands in the workspace, sandboxed with no network and a time limit";
export const BARE_SHELL_HINT =
  "No sandbox on this machine, so commands run only with Unsandboxed on";
export const UNSANDBOXED_HINT =
  "Run commands without a sandbox. They can read and change anything your account can, so keep this for sources you trust.";

/** `support` is null outside Tauri, where the stored policy is shown as is. */
export function shellControls(
  support: ShellSupport | null,
  shell: EngineToolPolicy["shell"],
): ShellControls {
  if (support && !support.available) {
    return {
      checked: false,
      disabled: true,
      hint: support.reason ?? "Shell commands are not available in this build.",
      showOptions: false,
      showUnsandboxed: false,
    };
  }
  const bare = support !== null && support.sandbox === null;
  return {
    checked: shell.enabled,
    disabled: false,
    hint: bare ? BARE_SHELL_HINT : SHELL_HINT,
    showOptions: shell.enabled,
    showUnsandboxed: shell.enabled && bare,
  };
}
