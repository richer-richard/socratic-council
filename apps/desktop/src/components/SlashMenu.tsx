import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  SLASH_COMMANDS,
  resolveSlash,
  slashProblem,
  suggestSlash,
  type SlashPlace,
  type SlashSuggestion,
} from "../utils/slash";

export interface SlashController {
  suggestions: SlashSuggestion[];
  selected: number;
  /** The list is showing: the input is a command and it was not put away. */
  open: boolean;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  select: (index: number) => void;
  /** Put the list away until the input changes (the first Esc). */
  hide: () => void;
  /** Call from the input's onChange: the list comes back, from the top. */
  edited: () => void;
  /** A key in the input. True when the command line took it. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** A click on row `index`. */
  pick: (index: number) => void;
  /** Run what is typed, as Enter would. */
  submit: () => void;
}

/**
 * The command line behaviour of an input: a value starting with `/` is a
 * command, never a topic. Enter runs the highlighted row (a command still
 * missing its argument fills in instead, to list its choices), the arrows
 * move, Tab fills in. `run` gets a resolved command and its argument, and
 * may return (or resolve to) a line to show under the list.
 */
export function useSlash({
  value,
  setValue,
  place,
  titles,
  run,
}: {
  value: string;
  setValue: (value: string) => void;
  place: SlashPlace;
  titles: readonly string[];
  run: (name: string, arg: string) => string | void | Promise<string | void>;
}): SlashController {
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isCommand = value.startsWith("/") && !value.includes("\n");
  const suggestions = useMemo(
    () => (isCommand ? suggestSlash(value, place, titles) : []),
    [isCommand, value, place, titles],
  );
  const open = isCommand && !hidden;

  const edited = useCallback(() => {
    setSelected(0);
    setHidden(false);
    setNotice(null);
  }, []);

  const fill = useCallback(
    (text: string) => {
      setValue(text);
      setSelected(0);
      setHidden(false);
    },
    [setValue],
  );

  const execute = useCallback(
    (input: string) => {
      const resolved = resolveSlash(input, place);
      if (resolved.kind === "run") {
        setValue("");
        setSelected(0);
        setNotice(null);
        // The input is already cleared, so a command that fails has to say so
        // here or it fails silently. A synchronous throw escapes the keydown
        // handler entirely, hence the try as well as the catch.
        const failed = (error: unknown) => {
          console.error("[slash] /" + resolved.name + " failed:", error);
          setNotice(
            error instanceof Error && error.message
              ? `/${resolved.name} could not run: ${error.message}`
              : `/${resolved.name} could not run.`,
          );
        };
        try {
          void Promise.resolve(run(resolved.name, resolved.arg)).then((said) => {
            if (said) setNotice(said);
          }, failed);
        } catch (error) {
          failed(error);
        }
        return;
      }
      if (resolved.kind === "needs-arg") {
        fill(`/${resolved.name} `);
        return;
      }
      setNotice(slashProblem(resolved, place));
    },
    [fill, place, run, setValue],
  );

  const pick = useCallback(
    (index: number) => {
      const s = suggestions[index];
      if (!s) {
        execute(value);
      } else if (!s.runs) {
        fill(s.fill);
      } else {
        execute(s.fill);
      }
    },
    [execute, fill, suggestions, value],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!isCommand) return false;
      const last = suggestions.length - 1;
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (open && last >= 0) pick(Math.min(selected, last));
        else execute(value);
        return true;
      }
      if (!open || last < 0) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((s) => Math.min(s + 1, last));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((s) => Math.max(Math.min(s, last) - 1, 0));
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        fill(suggestions[Math.min(selected, last)].fill);
        return true;
      }
      return false;
    },
    [execute, fill, isCommand, open, pick, selected, suggestions, value],
  );

  return {
    suggestions,
    selected: Math.min(selected, Math.max(suggestions.length - 1, 0)),
    open,
    notice,
    setNotice,
    select: setSelected,
    hide: () => setHidden(true),
    edited,
    onKeyDown,
    pick,
    submit: () => execute(value),
  };
}

/**
 * The list above a command line: the commands that start with what was
 * typed, then the close matches under a quiet label. The highlighted row is
 * what Enter runs; the pointer highlights the row under it.
 */
export function SlashMenu({ ctl, typed }: { ctl: SlashController; typed: string }) {
  // The list is capped at min(22rem, 50vh) and scrolls, so on a short window
  // or a long `/open` list the arrows would move the highlight past the
  // bottom edge with nothing to see and Enter running an invisible row.
  // Above the early return: the hooks run on every render either way.
  const selectedRow = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [ctl.selected, ctl.open, ctl.suggestions.length]);
  if (!ctl.open && !ctl.notice) return null;
  const firstClose = ctl.suggestions.findIndex((s) => s.close);
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands">
      {ctl.open && (
        <>
          <div className="slash-menu-head">
            <span>Commands</span>
            <span className="slash-menu-keys">
              <kbd>↑↓</kbd> pick <kbd>Tab</kbd> fill <kbd>Enter</kbd> run <kbd>Esc</kbd> close
            </span>
          </div>
          {ctl.suggestions.length === 0 && (
            <div className="slash-menu-empty">
              No command starts with {typed}. Type / to see them all.
            </div>
          )}
          {ctl.suggestions.map((s, i) => (
            // The index, not the text: two saved sessions can share a title
            // (reconvening keeps the topic), and `/open <title>` then gives two
            // rows the same fill and label. The list is rebuilt whole on every
            // keystroke and the rows hold no state of their own.
            <div key={`${i}-${s.fill}`}>
              {i === firstClose && (
                <div className="slash-menu-label">{i === 0 ? "Close matches" : "Close"}</div>
              )}
              <button
                type="button"
                role="option"
                ref={i === ctl.selected ? selectedRow : undefined}
                aria-selected={i === ctl.selected}
                className={`slash-menu-row ${i === ctl.selected ? "is-selected" : ""} ${
                  s.close ? "is-close" : ""
                }`}
                // Keep the focus (and the caret) in the input.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => ctl.select(i)}
                onClick={() => ctl.pick(i)}
              >
                <span className="slash-menu-command">{s.label}</span>
                <span className="slash-menu-about">{s.about}</span>
              </button>
            </div>
          ))}
        </>
      )}
      {ctl.notice && <div className="slash-notice">{ctl.notice}</div>}
    </div>
  );
}

const HOME_KEYS: [string, string][] = [
  ["Enter", "convene the council on what you typed"],
  ["Shift+Enter", "a new line"],
  ["Esc Esc", "clear what you typed"],
  ["Cmd+K", "the command palette"],
  ["Cmd+,", "settings"],
  ["Cmd+O", "attach files"],
];

const SESSION_KEYS: [string, string][] = [
  ["/", "open the command bar"],
  ["Esc", "close it"],
];

/** Every key and command for the page, over it. */
export function SlashHelp({ place, onClose }: { place: SlashPlace; onClose: () => void }) {
  const commands = SLASH_COMMANDS.filter((c) => (place === "home" ? c.home : c.session));
  return (
    <div
      className="slash-help-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="slash-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keys and commands"
        tabIndex={-1}
        ref={(node) => node?.focus()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="slash-help-head">
          <h2>Keys and commands</h2>
          <button type="button" className="slash-help-close" onClick={onClose}>
            Close
          </button>
        </div>
        <dl className="slash-help-list">
          {(place === "home" ? HOME_KEYS : SESSION_KEYS).map(([key, what]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <h3 className="slash-help-group">Commands, typed after /</h3>
        <dl className="slash-help-list">
          {commands.map((c) => (
            <div key={c.name}>
              <dt>/{c.name}</dt>
              <dd>{c.about}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
