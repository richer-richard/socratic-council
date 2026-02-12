import { useEffect, useMemo, useState } from "react";

type SearchMessage = {
  id: string;
  agentId: string;
  content: string;
  timestamp: number;
};

function buildSnippet(content: string, terms: string[], maxLen = 120) {
  const lower = content.toLowerCase();
  let bestIndex = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx === -1) continue;
    if (bestIndex === -1 || idx < bestIndex) bestIndex = idx;
  }

  if (bestIndex === -1) {
    const trimmed = content.trim();
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
  }

  const start = Math.max(0, bestIndex - Math.floor(maxLen * 0.35));
  const end = Math.min(content.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

export function ConversationSearch({
  messages,
  getAgentLabel,
  onJumpToMessage,
  onClose,
}: {
  messages: SearchMessage[];
  getAgentLabel: (agentId: string) => string;
  onJumpToMessage: (messageId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const terms = useMemo(() => {
    return query
      .trim()
      .toLowerCase()
      .split(/\s+/g)
      .filter(Boolean);
  }, [query]);

  const results = useMemo(() => {
    if (terms.length === 0) return [];

    return messages
      .filter((m) => {
        const haystack = `${getAgentLabel(m.agentId)} ${m.content}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .map((m) => ({
        ...m,
        snippet: buildSnippet(m.content, terms),
      }));
  }, [messages, terms, getAgentLabel]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const jumpTo = (index: number) => {
    if (results.length === 0) return;
    const clamped = ((index % results.length) + results.length) % results.length;
    setActiveIndex(clamped);
    onJumpToMessage(results[clamped]!.id);
  };

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="scale-in">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
          Search
        </h3>
        <button onClick={onClose} className="button-ghost text-xs">
          Close
        </button>
      </div>

      <div className="panel-card p-3">
        <input
          className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          placeholder="Search messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") jumpTo(activeIndex + 1);
          }}
        />

        <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
          <div>
            {terms.length === 0 ? "Type to search" : `${results.length} match${results.length === 1 ? "" : "es"}`}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="button-secondary text-xs px-2 py-1"
              disabled={results.length === 0}
              onClick={() => jumpTo(activeIndex - 1)}
              title="Previous match"
            >
              Prev
            </button>
            <button
              type="button"
              className="button-secondary text-xs px-2 py-1"
              disabled={results.length === 0}
              onClick={() => jumpTo(activeIndex + 1)}
              title="Next match"
            >
              Next
            </button>
          </div>
        </div>

        {results.length > 0 && (
          <div className="mt-3 space-y-2 max-h-[55vh] overflow-y-auto pr-1">
            {results.map((r, idx) => (
              <button
                key={r.id}
                type="button"
                onClick={() => jumpTo(idx)}
                className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                  idx === activeIndex
                    ? "bg-white/10 border-white/20"
                    : "bg-transparent border-white/10 hover:bg-white/5"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-ink-700 truncate">
                    {getAgentLabel(r.agentId)}
                  </div>
                  <div className="text-[11px] text-ink-500 tabular-nums">
                    {formatTime(r.timestamp)}
                  </div>
                </div>
                <div className="mt-1 text-[12px] text-ink-500 leading-snug">
                  {r.snippet}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

