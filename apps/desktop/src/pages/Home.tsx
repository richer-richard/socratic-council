import { useState, useMemo } from "react";
import type { Page } from "../App";
import { ConfigModal } from "../components/ConfigModal";
import { useConfig, getShuffledTopics, PROVIDER_INFO, type Provider } from "../stores/config";

interface HomeProps {
  onNavigate: (page: Page, topic?: string) => void;
}

export function Home({ onNavigate }: HomeProps) {
  const [topic, setTopic] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const {
    config,
    updateCredential,
    updateProxy,
    updateProxyOverride,
    updatePreferences,
    updateModel,
    updateMcp,
    hasAnyApiKey,
    getConfiguredProviders,
  } = useConfig();

  // Shuffle topics on each render/mount
  const sampleTopics = useMemo(() => getShuffledTopics(4), []);

  const handleStart = () => {
    if (!topic.trim()) return;
    
    if (!hasAnyApiKey()) {
      setShowApiWarning(true);
      return;
    }
    
    onNavigate("chat", topic.trim());
  };

  const handleSampleTopic = (sample: string) => {
    setTopic(sample);
  };

  const configuredProviders = getConfiguredProviders();

  return (
    <div className="app-shell flex-1 flex flex-col items-center justify-center p-8 overflow-auto relative">
      <div className="ambient-canvas" aria-hidden="true" />

      {/* Settings Button - Fixed Position */}
      <button
        onClick={() => setShowSettings(true)}
        className="absolute top-6 right-6 z-10 flex items-center gap-2 button-secondary"
      >
        <span className="text-lg">⚙️</span>
        <span className="font-medium">Settings</span>
        {configuredProviders.length > 0 && (
          <span className="ml-1 px-2 py-0.5 text-xs rounded-full badge badge-success">
            {configuredProviders.length}/5
          </span>
        )}
      </button>

      {/* Main Content */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Elegant Title Section */}
        <div className="text-center mb-16 scale-in">
          <div className="temple-icon mb-6">🏛️</div>
          <h1 className="elegant-title">Socratic Council</h1>
          <p className="elegant-subtitle">of Five</p>
          <p className="text-[1.05rem] text-ink-500 max-w-lg mx-auto mt-6 leading-relaxed">
            Multi-Agent Group Debate with Emergent Orchestration
          </p>
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
                ✕
              </button>
            )}
          </div>

          {/* Sample Topics */}
          <div className="mt-4">
            <p className="text-ink-500 text-sm mb-2">Try a sample topic:</p>
            <div className="flex flex-wrap gap-2">
              {sampleTopics.map((sample) => (
                <button
                  key={sample}
                  onClick={() => handleSampleTopic(sample)}
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
            <span className="text-2xl">🚀</span>
            <span>Begin Discussion</span>
          </button>
        </div>

        {/* API Key Warning */}
        {showApiWarning && !hasAnyApiKey() && (
          <div className="mt-6 api-warning-banner pulsing rounded-xl p-4 max-w-lg scale-in">
            <div className="flex items-start gap-3">
              <span className="text-2xl">⚠️</span>
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
                  Configure API Keys →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer Info */}
        <div className="mt-12 text-center text-ink-500 text-sm">
          <p className="mb-2">Agents compete through bidding to determine speaking order</p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {(Object.keys(PROVIDER_INFO) as Provider[]).map((provider) => {
              const info = PROVIDER_INFO[provider];
              const isConfigured = configuredProviders.includes(provider);
              return (
                <span
                  key={provider}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg
                    ${isConfigured ? "badge badge-success" : "badge"}`}
                >
                  <span>{info.avatar}</span>
                  <span className="text-xs">{info.name}</span>
                  {isConfigured && <span className="text-[10px]">✓</span>}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      <ConfigModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        config={config}
        onUpdateCredential={updateCredential}
        onUpdateProxy={updateProxy}
        onUpdateProxyOverride={updateProxyOverride}
        onUpdatePreferences={updatePreferences}
        onUpdateModel={updateModel}
        onUpdateMcp={updateMcp}
      />
    </div>
  );
}
