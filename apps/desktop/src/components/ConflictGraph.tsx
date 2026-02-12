import type { PairwiseConflict, AgentId } from "@socratic-council/shared";
import { useMemo, useState } from "react";

interface ConflictGraphProps {
  conflicts: PairwiseConflict[];
  agents: { id: AgentId; name: string; color: string }[];
}

// Pentagon layout: 5 nodes evenly spaced in a circle
const POSITIONS: Array<{ x: number; y: number }> = (() => {
  const cx = 120;
  const cy = 110;
  const r = 80;
  return Array.from({ length: 5 }, (_, i) => {
    // Start from top (-90deg) and go clockwise
    const angle = (-Math.PI / 2) + (2 * Math.PI * i) / 5;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });
})();

function scoreToColor(score: number): string {
  // Blue (low conflict) to Red (high conflict)
  const clamped = Math.max(0, Math.min(1, score));
  const r = Math.round(59 + clamped * (220 - 59));   // 59 -> 220
  const g = Math.round(130 + clamped * (38 - 130));   // 130 -> 38
  const b = Math.round(246 + clamped * (38 - 246));   // 246 -> 38
  return `rgb(${r},${g},${b})`;
}

function scoreToWidth(score: number): number {
  return 1 + Math.min(score, 1) * 3; // 1px to 4px
}

// Map agent CSS class colors to actual hex for SVG
const AGENT_HEX: Record<string, string> = {
  "text-george": "#3b82f6",
  "text-cathy": "#f59e0b",
  "text-grace": "#10b981",
  "text-douglas": "#F87171",
  "text-kate": "#2DD4BF",
};

export function ConflictGraph({ conflicts, agents }: ConflictGraphProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Build index map: agentId -> position index
  const idxMap = new Map<AgentId, number>();
  agents.forEach((a, i) => idxMap.set(a.id, i));

  const nameById = new Map(agents.map((a) => [a.id, a.name] as const));

  const sortedPairs = useMemo(() => {
    return [...conflicts].sort((a, b) => b.score - a.score);
  }, [conflicts]);

  const strongestPair = sortedPairs[0] ?? null;

  const renderPairLabel = (pair: PairwiseConflict) => {
    const a = nameById.get(pair.agents[0]) ?? pair.agents[0];
    const b = nameById.get(pair.agents[1]) ?? pair.agents[1];
    return (
      <span className="text-ink-700">
        {a} <span aria-hidden="true">↔</span> {b}
      </span>
    );
  };

  return (
    <div className="panel-card p-4 mb-6">
      <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3">
        Conflict Graph
      </h3>
      <svg viewBox="0 0 240 230" width="100%" style={{ maxWidth: 280 }}>
        {/* Edges */}
        {conflicts.map((pair) => {
          const iA = idxMap.get(pair.agents[0]);
          const iB = idxMap.get(pair.agents[1]);
          if (iA === undefined || iB === undefined) return null;
          const pA = POSITIONS[iA]!;
          const pB = POSITIONS[iB]!;
          const key = `${pair.agents[0]}-${pair.agents[1]}`;
          return (
            <line
              key={key}
              x1={pA.x}
              y1={pA.y}
              x2={pB.x}
              y2={pB.y}
              stroke={scoreToColor(pair.score)}
              strokeWidth={scoreToWidth(pair.score)}
              strokeLinecap="round"
              opacity={0.55 + pair.score * 0.45}
            />
          );
        })}
        {/* Nodes */}
        {agents.map((agent, i) => {
          const pos = POSITIONS[i]!;
          const fill = AGENT_HEX[agent.color] ?? "#888";
          return (
            <g key={agent.id}>
              <circle cx={pos.x} cy={pos.y} r={16} fill={fill} opacity={0.15} />
              <circle cx={pos.x} cy={pos.y} r={12} fill={fill} />
              <text
                x={pos.x}
                y={pos.y + 28}
                textAnchor="middle"
                fontSize="10"
                fill="currentColor"
                className="text-ink-600"
              >
                {agent.name}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Legend */}
      <div className="flex items-center justify-between mt-2 px-1">
        <span className="text-[10px] text-ink-400">Low</span>
        <div
          className="flex-1 mx-2 h-1.5 rounded-full"
          style={{
            background: `linear-gradient(to right, ${scoreToColor(0)}, ${scoreToColor(0.5)}, ${scoreToColor(1)})`,
          }}
        />
        <span className="text-[10px] text-ink-400">High</span>
      </div>

      {strongestPair && (
        <button
          type="button"
          className="mt-3 w-full text-left hover:opacity-90 transition-opacity"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
          title={isExpanded ? "Collapse tension list" : "Expand tension list"}
        >
          {isExpanded ? (
            <>
              <div className="text-[11px] text-ink-500">Top tension</div>
              <div className="mt-2 space-y-1">
                {sortedPairs.map((pair) => {
                  const key = `${pair.agents[0]}-${pair.agents[1]}`;
                  return (
                    <div key={key} className="grid grid-cols-[1fr,auto] items-center gap-3 text-[11px]">
                      <div className="truncate">{renderPairLabel(pair)}</div>
                      <div className="text-ink-400 tabular-nums">
                        {Math.round(pair.score * 100)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[auto,1fr,auto] items-center gap-3 text-[11px] text-ink-500">
                <span>Top tension</span>
                <span className="truncate">{renderPairLabel(strongestPair)}</span>
                <span className="text-ink-400 tabular-nums">
                  {Math.round(strongestPair.score * 100)}%
                </span>
              </div>
              {sortedPairs[1] && (
                <div className="grid grid-cols-[auto,1fr,auto] items-center gap-3 text-[11px] text-ink-500 mt-1">
                  <span aria-hidden="true" />
                  <span className="truncate">{renderPairLabel(sortedPairs[1])}</span>
                  <span className="text-ink-400 tabular-nums">
                    {Math.round(sortedPairs[1].score * 100)}%
                  </span>
                </div>
              )}
            </>
          )}
        </button>
      )}

      <p className="mt-2 text-[11px] text-ink-400 leading-relaxed">
        Scores are heuristic: they weight disagreement cues (e.g. “wrong”, “not convinced”) plus
        back-and-forth alternation over recent turns. Use as a vibe check, not a verdict.
      </p>
    </div>
  );
}
