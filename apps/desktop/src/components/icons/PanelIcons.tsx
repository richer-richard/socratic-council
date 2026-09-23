/**
 * Glyphs for the summary's panel switcher.
 *
 * Drawn rather than borrowed: each one is a small diagram of what its panel
 * shows, in the app's own language (thin strokes, square corners, geometry
 * that echoes the council mark). They take `currentColor`, so the active and
 * idle states are a colour change on the button, not a second asset.
 */

interface GlyphProps {
  size?: number;
  className?: string;
}

function frame(size: number, className: string | undefined, children: React.ReactNode) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      {children}
    </svg>
  );
}

/** A grid whose cells carry different weight: the heatmap, in miniature. */
export function MatrixGlyph({ size = 18, className }: GlyphProps) {
  const cells = [
    [3, 3, 1],
    [10, 3, 0.35],
    [17, 3, 0.7],
    [3, 10, 0.35],
    [10, 10, 0.85],
    [17, 10, 0.2],
    [3, 17, 0.6],
    [10, 17, 0.2],
    [17, 17, 0.45],
  ] as const;
  return frame(
    size,
    className,
    cells.map(([x, y, weight]) => (
      <rect
        key={`${x}-${y}`}
        x={x}
        y={y}
        width="4"
        height="4"
        fill="currentColor"
        fillOpacity={weight}
        stroke="none"
      />
    )),
  );
}

/** Two positions starting apart and meeting: the convergence judgement. */
export function ConvergeGlyph({ size = 18, className }: GlyphProps) {
  return frame(
    size,
    className,
    <>
      <path d="M3 4 L11 11 L20 12" strokeLinecap="square" />
      <path d="M3 20 L11 13 L20 12" strokeLinecap="square" />
      <rect x="18.5" y="10.5" width="3" height="3" fill="currentColor" stroke="none" />
    </>,
  );
}

/** Seats rating each other: nodes around a ring, with the chords between. */
export function CritiqueGlyph({ size = 18, className }: GlyphProps) {
  const pts = [
    [12, 3],
    [20, 12],
    [12, 21],
    [4, 12],
  ] as const;
  return frame(
    size,
    className,
    <>
      {pts.map(([x1, y1], i) =>
        pts
          .slice(i + 1)
          .map(([x2, y2], j) => (
            <line key={`${i}-${j}`} x1={x1} y1={y1} x2={x2} y2={y2} strokeOpacity="0.45" />
          )),
      )}
      {pts.map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x - 1.8}
          y={y - 1.8}
          width="3.6"
          height="3.6"
          fill="currentColor"
          stroke="none"
        />
      ))}
    </>,
  );
}

/** A claim with what supports it and what pushes back: the argument map. */
export function ArgumentGlyph({ size = 18, className }: GlyphProps) {
  return frame(
    size,
    className,
    <>
      <rect x="9" y="2.5" width="6" height="4" />
      <path d="M12 6.5 L12 11" />
      <path d="M5.5 17 L5.5 13 L18.5 13 L18.5 17" />
      <path d="M12 11 L12 13" />
      <rect x="2.5" y="17" width="6" height="4" />
      <rect x="15.5" y="17" width="6" height="4" />
      {/* The right branch is the rebuttal: struck through, not just attached. */}
      <path d="M16.8 18.2 L20.2 19.8" strokeWidth="1.2" />
    </>,
  );
}
