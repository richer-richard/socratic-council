import { useState, useMemo } from "react";
import type { Page } from "../App";
import { Starfield } from "../components/Starfield";
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
    updatePreferences,
    updateModel,
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
    <div className="flex-1 flex flex-col items-center justify-center p-8 overflow-auto relative">
      {/* Starfield Background */}
      <Starfield />

      {/* Settings Button - Fixed Position */}
      <button
        onClick={() => setShowSettings(true)}
        className="absolute top-6 right-6 z-10 flex items-center gap-2 
          bg-gray-800/60 hover:bg-gray-700/80 backdrop-blur-sm
          text-gray-300 hover:text-white px-4 py-2.5 rounded-xl
          border border-gray-700/50 hover:border-gray-600
          transition-all duration-200 shadow-lg"
      >
        <span className="text-lg">⚙️</span>
        <span className="font-medium">Settings</span>
        {configuredProviders.length > 0 && (
          <span className="ml-1 px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded-full">
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
          <p className="text-gray-400 text-lg max-w-lg mx-auto mt-6 leading-relaxed">
            Multi-Agent Group Debate with Emergent Orchestration
          </p>
        </div>

        {/* Topic Input Section */}
        <div className="w-full max-w-2xl mb-8 scale-in glass-card rounded-2xl p-6">
          <label className="block text-gray-300 font-medium mb-3 text-lg">
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
                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white
                  w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors"
              >
                ✕
              </button>
            )}
          </div>

          {/* Sample Topics */}
          <div className="mt-4">
            <p className="text-gray-500 text-sm mb-2">Try a sample topic:</p>
            <div className="flex flex-wrap gap-2">
              {sampleTopics.map((sample) => (
                <button
                  key={sample}
                  onClick={() => handleSampleTopic(sample)}
                  className="bg-gray-700/50 hover:bg-gray-700 text-gray-300 hover:text-white
                    text-sm px-3 py-1.5 rounded-lg transition-all duration-200
                    border border-gray-600/30 hover:border-gray-500"
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
                <h4 className="text-red-400 font-semibold">No API Keys Configured</h4>
                <p className="text-red-300/80 text-sm mt-1 mb-3">
                  Please configure at least one API key before starting a discussion.
                  The council needs AI providers to function.
                </p>
                <button
                  onClick={() => {
                    setShowApiWarning(false);
                    setShowSettings(true);
                  }}
                  className="bg-red-500/20 hover:bg-red-500/30 text-red-400 
                    px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Configure API Keys →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer Info */}
        <div className="mt-12 text-center text-gray-500 text-sm">
          <p className="mb-2">Agents compete through bidding to determine speaking order</p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {(Object.keys(PROVIDER_INFO) as Provider[]).map((provider, i) => {
              const info = PROVIDER_INFO[provider];
              const isConfigured = configuredProviders.includes(provider);
              return (
                <span
                  key={provider}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg
                    ${isConfigured ? "bg-green-500/10 text-green-400" : "bg-gray-800/50 text-gray-500"}`}
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
        onUpdatePreferences={updatePreferences}
        onUpdateModel={updateModel}
      />
    </div>
  );
}
