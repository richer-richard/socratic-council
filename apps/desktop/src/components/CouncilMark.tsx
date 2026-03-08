interface CouncilMarkProps {
  size?: number;
  className?: string;
}

export function CouncilMark({ size = 80, className }: CouncilMarkProps) {
  const pts = Array.from({ length: 7 }, (_, i) => {
    const angle = (-Math.PI / 2) + (2 * Math.PI * i) / 7;
    return { x: 60 + 40 * Math.cos(angle), y: 58 + 40 * Math.sin(angle) };
  });
  const colors = ["#60a5fa", "#fbbf24", "#34d399", "#f87171", "#2dd4bf", "#22d3ee", "#f472b6"];

  return (
    <svg
      viewBox="0 0 120 116"
      width={size}
      height={(size / 80) * 76}
      aria-hidden="true"
      className={className}
    >
      {pts.map((a, i) =>
        pts.slice(i + 1).map((b, j) => (
          <line
            key={`${i}-${i + 1 + j}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="rgba(148,163,184,0.25)"
            strokeWidth="1"
          />
        ))
      )}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={10} fill={colors[i]} opacity={0.18} />
          <circle cx={p.x} cy={p.y} r={6} fill={colors[i]} />
        </g>
      ))}
    </svg>
  );
}
