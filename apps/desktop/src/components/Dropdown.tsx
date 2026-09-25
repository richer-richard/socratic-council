import { useEffect, useLayoutEffect, useRef, useState } from "react";

function IconChevronDown() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/**
 * The right edge a panel must stay inside: the nearest ancestor that clips or
 * scrolls sideways, else the window. A panel past it would add a sideways
 * scrollbar to that container (the Settings dialog) or be cut off.
 */
function clipRight(from: HTMLElement): number {
  for (let el = from.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowX !== "visible") {
      const rect = el.getBoundingClientRect();
      return rect.left + el.clientLeft + el.clientWidth;
    }
  }
  return window.innerWidth;
}

/** The visible top and bottom of the nearest ancestor that clips or scrolls. */
function clipBand(from: HTMLElement): { top: number; bottom: number } {
  for (let el = from.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== "visible") {
      const rect = el.getBoundingClientRect();
      const top = rect.top + el.clientTop;
      return { top, bottom: top + el.clientHeight };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * Custom dropdown that replaces the native <select>. Tauri renders the OS
 * default popup which fights the cinematic-dark theme; this listbox
 * panel inherits the same gold-on-dark palette as the rest of the app.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);

  // Opens under the trigger's left edge, measured before it paints: under
  // its right edge instead when that would run past the container, and above
  // the trigger when the container has no room below and more above.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = containerRef.current;
    if (!open || !panel || !trigger) {
      setAlignEnd(false);
      setOpenUp(false);
      return;
    }
    const rect = panel.getBoundingClientRect();
    setAlignEnd(rect.right > clipRight(panel));
    const band = clipBand(panel);
    const box = trigger.getBoundingClientRect();
    setOpenUp(rect.bottom > band.bottom && box.top - band.top > band.bottom - box.bottom);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);

  return (
    <div ref={containerRef} className="app-dropdown">
      <button
        type="button"
        className="app-dropdown-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="app-dropdown-value">{current?.label ?? value}</span>
        <span className={`app-dropdown-caret ${open ? "is-open" : ""}`}>
          <IconChevronDown />
        </span>
      </button>
      {open && (
        <ul
          ref={panelRef}
          className={`app-dropdown-panel${alignEnd ? " is-align-end" : ""}${openUp ? " is-open-up" : ""}`}
          role="listbox"
          tabIndex={-1}
        >
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                className={`app-dropdown-item ${option.value === value ? "is-selected" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
