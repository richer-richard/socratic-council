import { useEffect, useMemo, useRef, useState } from "react";

import { ChamberSurface } from "./ChamberSurface";
import {
  filterCommands,
  listCommands,
  type Command,
  type ScoredCommand,
} from "../utils/commandPalette";

/**
 * Command palette — ⌘K opens a hushed floating surface with a fuzzy filter.
 *
 * Pulls from the singleton registry in `utils/commandPalette.ts`; anywhere
 * in the app can `registerCommand({id,label,run})` and the item shows up
 * here automatically. Arrow keys navigate, Enter executes, Esc dismisses.
 *
 * Global ⌘K binding lives in `useCommandPalette` below — mount it once at
 * the App root so the shortcut works from any page.
 */

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results: ScoredCommand[] = useMemo(() => {
    return filterCommands(query, listCommands());
  }, [query, open]); // include `open` so re-opening re-reads the registry

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    // Clamp the highlight when the result set shrinks.
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results, selectedIndex]);

  useEffect(() => {
    // Scroll the active row into view.
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-row-index="${selectedIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex]);

  const runAt = (idx: number) => {
    const result = results[idx];
    if (!result) return;
    onClose();
    // Defer the command so the surface's unmount animations finish first.
    setTimeout(() => {
      void result.command.run();
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(selectedIndex);
    }
  };

  return (
    <ChamberSurface
      open={open}
      onClose={onClose}
      ariaLabel="Command palette"
      kicker="Command Palette"
      shortcutHint="↑↓ to navigate · ⏎ to run · Esc to dismiss"
      maxWidth={620}
      anchor="top"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search commands — try 'new', 'export', 'settings'…"
        autoComplete="off"
        spellCheck={false}
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "rgba(10, 10, 14, 0.55)",
          border: "1px solid rgba(232, 232, 239, 0.1)",
          borderRadius: "8px",
          color: "#f8f8fc",
          fontFamily: "inherit",
          fontSize: "0.96rem",
          lineHeight: 1.5,
          outline: "none",
          transition: "border-color 120ms ease, box-shadow 120ms ease",
          marginBottom: results.length > 0 ? "14px" : 0,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "rgba(245, 197, 66, 0.48)";
          e.currentTarget.style.boxShadow = "0 0 0 3px rgba(245, 197, 66, 0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "rgba(232, 232, 239, 0.1)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />

      {results.length === 0 && query.trim() !== "" && (
        <div
          style={{
            padding: "24px 8px",
            textAlign: "center",
            fontSize: "0.85rem",
            color: "rgba(232, 232, 239, 0.45)",
            fontStyle: "italic",
          }}
        >
          No commands match "{query}".
        </div>
      )}

      <div
        ref={listRef}
        role="listbox"
        aria-label="Commands"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          maxHeight: "min(50vh, 420px)",
          overflowY: "auto",
          paddingRight: "2px",
        }}
      >
        {results.map((result, idx) => (
          <CommandRow
            key={result.command.id}
            command={result.command}
            active={idx === selectedIndex}
            onHover={() => setSelectedIndex(idx)}
            onRun={() => runAt(idx)}
            rowIndex={idx}
          />
        ))}
      </div>
    </ChamberSurface>
  );
}

function CommandRow({
  command,
  active,
  onHover,
  onRun,
  rowIndex,
}: {
  command: Command;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
  rowIndex: number;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-row-index={rowIndex}
      onMouseEnter={onHover}
      onClick={onRun}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: "8px",
        cursor: "pointer",
        background: active ? "rgba(245, 197, 66, 0.1)" : "transparent",
        border: active
          ? "1px solid rgba(245, 197, 66, 0.32)"
          : "1px solid transparent",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
        <div
          style={{
            fontSize: "0.92rem",
            fontWeight: 500,
            color: active ? "#f8f8fc" : "rgba(232, 232, 239, 0.85)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {command.label}
        </div>
        {(command.subtitle || command.category) && (
          <div
            style={{
              fontSize: "0.72rem",
              color: "rgba(232, 232, 239, 0.45)",
              display: "flex",
              gap: "10px",
              alignItems: "center",
            }}
          >
            {command.category && (
              <span
                style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  letterSpacing: "0.06em",
                  color: "rgba(245, 197, 66, 0.6)",
                }}
              >
                {command.category}
              </span>
            )}
            {command.subtitle && <span>{command.subtitle}</span>}
          </div>
        )}
      </div>
      {command.shortcut && (
        <div
          style={{
            fontSize: "0.72rem",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: "rgba(232, 232, 239, 0.5)",
            padding: "2px 8px",
            background: "rgba(232, 232, 239, 0.06)",
            borderRadius: "5px",
            whiteSpace: "nowrap",
            marginLeft: "12px",
            flexShrink: 0,
          }}
        >
          {command.shortcut}
        </div>
      )}
    </div>
  );
}

/**
 * Mount once at App root. Binds ⌘K / Ctrl+K to open the palette and renders
 * the palette itself. The `children` prop is just a passthrough so this hook
 * can be used as an opaque wrapper.
 */
export function useCommandPaletteShortcut(): {
  open: boolean;
  close: () => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return {
    open,
    close: () => setOpen(false),
    toggle: () => setOpen((p) => !p),
  };
}
