import { useState, useMemo } from "react";
import type { Page } from "../App";
import { ConfigModal } from "../components/ConfigModal";
import { Starfield } from "../components/Starfield";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import { useConfig, getShuffledTopics, PROVIDER_INFO, type Provider } from "../stores/config";

interface HomeProps {
  onNavigate: (page: Page, topic?: string) => void;
}

const AGENT_CARDS: Array<{
  provider: Provider;
  name: string;
  color: string;
}> = [
  { provider: "openai", name: "George", color: "var(--color-george)" },
  { provider: "anthropic", name: "Cathy", color: "var(--color-cathy)" },
  { provider: "google", name: "Grace", color: "var(--color-grace)" },
  { provider: "deepseek", name: "Douglas", color: "var(--color-douglas)" },
  { provider: "kimi", name: "Kate", color: "var(--color-kate)" },
];

const MODEL_DISPLAY: Record<string, string> = {
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-pro": "GPT-5.2 Pro",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5-20251101": "Opus 4.5",
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "gemini-3-pro-preview": "Gemini 3 Pro",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "deepseek-reasoner": "Reasoner",
  "deepseek-chat": "Chat",
  "kimi-k2.5": "K2.5",
  "kimi-k2-thinking": "K2 Thinking",
};

/** SVG council icon — pentagon with 5 connected nodes */
function CouncilIcon() {
  // Pentagon vertices (cx=60, cy=58, r=40), starting from top
  const pts = Array.from({ length: 5 }, (_, i) => {
    const angle = (-Math.PI / 2) + (2 * Math.PI * i) / 5;
    return { x: 60 + 40 * Math.cos(angle), y: 58 + 40 * Math.sin(angle) };
  });
  const colors = ["#60a5fa", "#fbbf24", "#34d399", "#f87171", "#2dd4bf"];

  return (
    <svg viewBox="0 0 120 116" width="80" height="76" aria-hidden="true">
      {/* Connecting lines (all 10 pairs) */}
      {pts.map((a, i) =>
        pts.slice(i + 1).map((b, j) => (
          <line
            key={`${i}-${i + 1 + j}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="rgba(148,163,184,0.25)" strokeWidth="1"
          />
        ))
      )}
      {/* Nodes */}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={10} fill={colors[i]} opacity={0.18} />
          <circle cx={p.x} cy={p.y} r={6} fill={colors[i]} />
        </g>
      ))}
    </svg>
  );
}

/** SVG gear icon */
function GearIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v1m0 6v1m4-4h-1m-6 0H8m5.66 2.66l-.71.71m-3.9-3.9l-.71.71m4.61 0l.71.71m-3.9 3.9l.71.71" />
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** SVG alert triangle icon */
function AlertIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function Home({ onNavigate }: HomeProps) {
  const [topic, setTopic] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const {
    config,
    updateCredential,
    updateProxy,
    updatePreferences,
    updateModel,
    hasAnyApiKey,
    getConfiguredProviders,
  } = useConfig();

  const sampleTopics = useMemo(() => getShuffledTopics(4), []);

  const handleStart = () => {
    if (!topic.trim()) return;
    if (!hasAnyApiKey()) {
      setShowApiWarning(true);
      return;
    }
    onNavigate("chat", topic.trim());
  };

  const configuredProviders = getConfiguredProviders();

  return (
    <div className="app-shell flex-1 flex flex-col items-center justify-center p-8 overflow-auto relative">
      <div className="ambient-canvas" aria-hidden="true" />
      <Starfield />

      {/* Settings Button */}
      <button
        onClick={() => setShowSettings(true)}
        className="absolute top-6 right-6 z-10 flex items-center gap-2 button-secondary"
      >
        <GearIcon size={18} />
        <span className="font-medium">Settings</span>
        {configuredProviders.length > 0 && (
          <span className="ml-1 px-2 py-0.5 text-xs rounded-full badge badge-success">
            {configuredProviders.length}/5
          </span>
        )}
      </button>

      {/* Main Content */}
      <div className="relative z-10 flex flex-col items-center max-w-3xl w-full">
        {/* Title Section */}
        <div className="text-center mb-10 scale-in">
          <div className="mb-5 flex justify-center" style={{ animation: "float 6s ease-in-out infinite" }}>
            <CouncilIcon />
          </div>
          <h1 className="elegant-title">Socratic Council</h1>
          <p className="elegant-subtitle">of Five</p>
          <p className="text-[1.05rem] text-ink-500 max-w-lg mx-auto mt-5 leading-relaxed">
            Five AI agents. One topic. No holds barred.
          </p>
        </div>

        {/* Agent Cards Row */}
        <div className="agent-cards-row mb-10 scale-in w-full">
          {AGENT_CARDS.map((agent) => {
            const isConfigured = configuredProviders.includes(agent.provider);
            const modelId = config.models[agent.provider];
            const modelLabel = modelId ? (MODEL_DISPLAY[modelId] ?? modelId) : "—";

            return (
              <div key={agent.provider} className="agent-card" style={{ "--agent-color": agent.color } as React.CSSProperties}>
                <ProviderIcon provider={agent.provider} size={36} />
                <span className="agent-card-name" style={{ color: agent.color }}>{agent.name}</span>
                <span className="agent-card-provider">{PROVIDER_INFO[agent.provider].name}</span>
                <span className="agent-card-model">{modelLabel}</span>
                <span className={`agent-card-status ${isConfigured ? "configured" : ""}`}>
                  {isConfigured ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {/* Topic Input Section */}
        <div className="w-full max-w-2xl mb-8 scale-in panel-card p-6">
          <label className="block text-ink-700 font-medium mb-3 text-lg">
            What should the council discuss?
          </label>
          <div className="relative">
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStart()}
              placeholder="Enter a thought-provoking topic..."
              className="elegant-input"
            />
            {topic && (
              <button
                onClick={() => setTopic("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-900
                  w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/70 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          {/* Sample Topics */}
          <div className="mt-4">
            <p className="text-ink-500 text-sm mb-2">Try:</p>
            <div className="flex flex-wrap gap-2">
              {sampleTopics.map((sample) => (
                <button
                  key={sample}
                  onClick={() => setTopic(sample)}
                  className="button-secondary text-sm px-3 py-1.5"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Start Button */}
        <div className="scale-in">
          <button
            onClick={handleStart}
            disabled={!topic.trim()}
            className="start-button flex items-center gap-3"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
            <span>Begin Discussion</span>
          </button>
        </div>

        {/* API Key Warning */}
        {showApiWarning && !hasAnyApiKey() && (
          <div className="mt-6 api-warning-banner pulsing rounded-xl p-4 max-w-lg scale-in">
            <div className="flex items-start gap-3">
              <span className="text-ink-700 flex-shrink-0 mt-0.5">
                <AlertIcon size={22} />
              </span>
              <div>
                <h4 className="text-ink-900 font-semibold">No API Keys Configured</h4>
                <p className="text-ink-700 text-sm mt-1 mb-3">
                  Please configure at least one API key before starting a discussion.
                  The council needs AI providers to function.
                </p>
                <button
                  onClick={() => {
                    setShowApiWarning(false);
                    setShowSettings(true);
                  }}
                  className="button-secondary text-sm"
                >
                  Configure API Keys
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block", marginLeft: 4, verticalAlign: "middle" }}>
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Settings Modal */}
      <ConfigModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        config={config}
        onUpdateCredential={updateCredential}
        onUpdateProxy={updateProxy}
        onUpdatePreferences={updatePreferences}
        onUpdateModel={updateModel}
      />
    </div>
  );
}
