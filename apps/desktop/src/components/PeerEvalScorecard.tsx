import type { PeerEvalRound, PeerEvalScores } from "@socratic-council/core";
import type { AgentId } from "@socratic-council/shared";
import { useMemo, useState } from "react";

interface PeerEvalScorecardProps {
  round: PeerEvalRound;
  agents: { id: AgentId; name: string; color: string }[];
}

const AGENT_HEX: Record<string, string> = {
  "text-george": "#3b82f6",
  "text-cathy": "#f59e0b",
  "text-grace": "#10b981",
  "text-douglas": "#F87171",
  "text-kate": "#2DD4BF",
  "text-quinn": "#22D3EE",
  "text-mary": "#F472B6",
  "text-zara": "#A78BFA",
};

const DIMENSIONS: { key: keyof PeerEvalScores; label: string }[] = [
  { key: "rigor", label: "rigor" },
  { key: "evidence", label: "evid" },
  { key: "novelty", label: "novel" },
  { key: "civility", label: "civil" },
  { key: "onTopic", label: "topic" },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace("#", "");
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return [r, g, b];
}

const TERRACOTTA = hexToRgb("#fb7185");
const NEUTRAL = hexToRgb("#475569");
const GOLD = hexToRgb("#f59e0b");

function scoreToCellColor(score: number): { bg: string; fg: string } {
  const clamped = Math.max(0, Math.min(100, score));
  const t = clamped / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const u = t / 0.5;
    [r, g, b] = [
      lerp(TERRACOTTA[0], NEUTRAL[0], u),
      lerp(TERRACOTTA[1], NEUTRAL[1], u),
      lerp(TERRACOTTA[2], NEUTRAL[2], u),
    ];
  } else {
    const u = (t - 0.5) / 0.5;
    [r, g, b] = [
      lerp(NEUTRAL[0], GOLD[0], u),
      lerp(NEUTRAL[1], GOLD[1], u),
      lerp(NEUTRAL[2], GOLD[2], u),
    ];
  }
  // Darker, semi-transparent fill so it sits in the panel's dark surface.
  const bg = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0.32)`;
  const fg = clamped >= 65 ? "#f8fafc" : clamped <= 30 ? "#fff5f6" : "#e7eaf2";
  return { bg, fg };
}

export function PeerEvalScorecard({ round, agents }: PeerEvalScorecardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedTarget, setExpandedTarget] = useState<AgentId | null>(null);

  const nameById = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name] as const)),
    [agents],
  );
  const colorById = useMemo(
    () => new Map(agents.map((a) => [a.id, AGENT_HEX[a.color] ?? "#9aa6bd"] as const)),
    [agents],
  );

  // Display rows in rank order (best → worst).
  const rankedRows = useMemo(() => {
    return [...round.agentIds]
      .map((id) => ({ id, summary: round.perAgentSummary[id] }))
      .sort((a, b) => (a.summary?.rank ?? 999) - (b.summary?.rank ?? 999));
  }, [round]);

  const critiquesByTarget = useMemo(() => {
    const map = new Map<AgentId, typeof round.critiques>();
    for (const id of round.agentIds) map.set(id, []);
    for (const c of round.critiques) {
      const list = map.get(c.targetId);
      if (list) list.push(c);
    }
    return map;
  }, [round]);

  const totalCritiques = round.critiques.length;
  const failed = round.failedEvaluators.length;

  return (
    <div className="panel-card p-4 mb-6 peer-eval-scorecard">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between text-left mb-3"
        aria-expanded={!collapsed}
        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
      >
        <h3
          className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Peer Review Scorecard
        </h3>
        <span
          className="text-[11px] text-ink-500"
          style={{ fontFamily: "var(--font-mono)" }}
          aria-hidden="true"
        >
          {totalCritiques} critiques · {round.turnsCompleted} turns
          {failed > 0 ? ` · ${failed} eval${failed === 1 ? "" : "s"} failed` : ""}{" "}
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {!collapsed && (
        <div className="peer-eval-scorecard-body">
          <div
            className="grid items-center gap-x-2 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-ink-500"
            style={{
              fontFamily: "var(--font-mono)",
              gridTemplateColumns: "1fr repeat(5, 2.4rem) 2.4rem 1.6rem",
            }}
          >
            <span>Agent</span>
            {DIMENSIONS.map((d) => (
              <span key={d.key} className="text-right">
                {d.label}
              </span>
            ))}
            <span className="text-right">avg</span>
            <span className="text-right">rk</span>
          </div>

          <div className="mt-1 space-y-1">
            {rankedRows.map(({ id, summary }) => {
              const isExpanded = expandedTarget === id;
              const color = colorById.get(id) ?? "#9aa6bd";
              const name = nameById.get(id) ?? id;
              const reviews = critiquesByTarget.get(id) ?? [];
              if (!summary) return null;
              return (
                <div key={id}>
                  <button
                    type="button"
                    onClick={() => setExpandedTarget(isExpanded ? null : id)}
                    aria-expanded={isExpanded}
                    className="w-full grid items-center gap-x-2 px-2 py-1.5 text-left rounded-md peer-eval-row"
                    style={{
                      gridTemplateColumns: "1fr repeat(5, 2.4rem) 2.4rem 1.6rem",
                      background: isExpanded
                        ? "rgba(245, 197, 66, 0.06)"
                        : "rgba(255,255,255,0.02)",
                      border: isExpanded
                        ? "1px solid rgba(245,197,66,0.32)"
                        : "1px solid transparent",
                      cursor: "pointer",
                    }}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block rounded-full"
                        style={{
                          width: 8,
                          height: 8,
                          background: color,
                          flexShrink: 0,
                        }}
                        aria-hidden="true"
                      />
                      <span
                        className="truncate text-xs text-ink-900"
                        style={{ fontFamily: "var(--font-body)" }}
                      >
                        {name}
                      </span>
                      <span
                        className="text-[10px] text-ink-500 tabular-nums"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {summary.reviewsReceived} rev
                      </span>
                    </span>
                    {DIMENSIONS.map((d) => {
                      const score = summary.averageScores[d.key];
                      const { bg, fg } = scoreToCellColor(score);
                      return (
                        <span
                          key={d.key}
                          className="text-right tabular-nums text-[11px] py-0.5 px-1 rounded"
                          style={{
                            fontFamily: "var(--font-mono)",
                            background: bg,
                            color: fg,
                          }}
                        >
                          {score}
                        </span>
                      );
                    })}
                    <span
                      className="text-right tabular-nums text-[11px] py-0.5 px-1 rounded"
                      style={{
                        fontFamily: "var(--font-mono)",
                        background: scoreToCellColor(summary.overallAverage).bg,
                        color: "#fff",
                        fontWeight: 600,
                      }}
                    >
                      {summary.overallAverage}
                    </span>
                    <span
                      className="text-right tabular-nums text-[11px] text-ink-700"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      #{summary.rank}
                    </span>
                  </button>

                  {isExpanded && (
                    <div
                      className="px-3 py-2 mt-1 mb-1 rounded-md"
                      style={{
                        background: "rgba(0,0,0,0.18)",
                        borderLeft: `2px solid ${color}`,
                      }}
                    >
                      {summary.standoutCritique && (
                        <p
                          className="text-[12px] text-ink-700 leading-snug"
                          style={{ fontFamily: "var(--font-body)" }}
                        >
                          <span
                            className="text-[10px] uppercase tracking-[0.18em] text-ink-500 mr-1"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            Sharpest critique:
                          </span>
                          {summary.standoutCritique}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {reviews
                          .slice()
                          .sort((a, b) => a.overall - b.overall)
                          .map((c) => (
                            <span
                              key={`${c.evaluatorId}-${c.targetId}`}
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                fontFamily: "var(--font-mono)",
                                background: scoreToCellColor(c.overall).bg,
                                color: "#f8fafc",
                              }}
                            >
                              {nameById.get(c.evaluatorId) ?? c.evaluatorId}: {c.overall}
                            </span>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p
            className="mt-3 text-[10px] text-ink-500 leading-relaxed"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Each agent rates the others 0–100 on rigor, evidence, novelty, civility, and on-topic.
            Cells redden as scores drop, and gild as they climb. Click any row to see the per-evaluator
            breakdown and the sharpest critique that agent received.
          </p>
        </div>
      )}
    </div>
  );
}
