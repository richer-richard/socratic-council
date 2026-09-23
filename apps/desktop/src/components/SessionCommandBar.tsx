import { useEffect, useRef, useState } from "react";

import { quitApp } from "../services/appWindow";

import { SlashHelp, SlashMenu, useSlash } from "./SlashMenu";

export interface SessionCommands {
  running: boolean;
  onSummary: () => void;
  onTranscript: () => void;
  onExport: () => void;
  onStop: () => void;
  onReconvene: () => void;
  onHome: () => void;
  onSettings: () => void;
}

const NO_TITLES: string[] = [];

/** True when a key press belongs to something being typed into. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/**
 * `/` on a session page opens a command bar at the foot of the window, with
 * the same list above it as the Home composer. Esc closes it.
 */
export function SessionCommandBar(props: SessionCommands) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("/");
  const [help, setHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const slash = useSlash({
    value,
    setValue,
    place: "session",
    titles: NO_TITLES,
    run: (name) => {
      setOpen(false);
      switch (name) {
        case "summary":
          props.onSummary();
          break;
        case "transcript":
          props.onTranscript();
          break;
        case "export":
          props.onExport();
          break;
        case "stop":
          if (props.running) props.onStop();
          else flash("The council is not sitting.");
          break;
        case "reconvene":
          if (props.running) flash("The council is still sitting. /stop it first.");
          else props.onReconvene();
          break;
        case "home":
          props.onHome();
          break;
        case "settings":
          props.onSettings();
          break;
        case "help":
          setHelp(true);
          break;
        case "quit":
          return quitApp().then((closed) => {
            if (!closed) flash("Quit works in the app, not in a browser tab.");
          });
      }
    },
  });

  // What a command that could not act says, once the bar has closed.
  const [message, setMessage] = useState<string | null>(null);
  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage((m) => (m === text ? null : m)), 3200);
  }

  const edited = slash.edited;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open || help) return;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingTarget(event.target)) return;
      // A dialog (export, a question) owns the keyboard while it is up.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      setValue("/");
      edited();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, help, edited]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <>
      {open && (
        <div className="session-command-bar">
          <div className="session-command-anchor">
            <SlashMenu ctl={slash} typed={value} />
            <input
              ref={inputRef}
              className="session-command-input"
              value={value}
              aria-label="Command"
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                // Deleting the slash closes the bar, as it opened.
                if (!next.startsWith("/")) {
                  setOpen(false);
                  return;
                }
                setValue(next);
                slash.edited();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  return;
                }
                slash.onKeyDown(event);
              }}
              onBlur={() => setOpen(false)}
            />
          </div>
        </div>
      )}
      {!open && message && (
        <div className="session-command-bar is-message" role="status">
          <div className="slash-notice">{message}</div>
        </div>
      )}
      {help && <SlashHelp place="session" onClose={() => setHelp(false)} />}
    </>
  );
}
