import { useState } from "react";
import {
  type Provider,
  type ProxyType,
  type AppConfig,
  PROVIDER_INFO,
  DISCUSSION_LENGTHS,
} from "../stores/config";

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onUpdateCredential: (provider: Provider, credential: { apiKey: string; baseUrl?: string; verified?: boolean; lastTested?: number } | null) => void;
  onUpdateProxy: (proxy: AppConfig["proxy"]) => void;
  onUpdatePreferences: (preferences: Partial<AppConfig["preferences"]>) => void;
  onUpdateModel: (provider: Provider, model: string) => void;
}

type TabType = "api-keys" | "models" | "proxy" | "preferences";

const PROVIDERS = Object.keys(PROVIDER_INFO) as Provider[];

const MODEL_OPTIONS: Record<Provider, { id: string; name: string }[]> = {
  openai: [
    { id: "gpt-5.2-pro", name: "GPT-5.2 Pro (Reasoning)" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
    { id: "o3", name: "o3 (Reasoning)" },
    { id: "o4-mini", name: "o4-mini" },
    { id: "gpt-4o", name: "GPT-4o (Legacy)" },
  ],
  anthropic: [
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet (Legacy)" },
  ],
  google: [
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  deepseek: [
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
  ],
  kimi: [
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "kimi-k2-thinking", name: "Kimi K2 Thinking" },
    { id: "moonshot-v1-128k", name: "Moonshot V1 128K" },
  ],
};

export function ConfigModal({
  isOpen,
  onClose,
  config,
  onUpdateCredential,
  onUpdateProxy,
  onUpdatePreferences,
  onUpdateModel,
}: ConfigModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>("api-keys");
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [testingProvider, setTestingProvider] = useState<Provider | null>(null);
  const [testResults, setTestResults] = useState<Record<Provider, "success" | "failed" | "error" | null>>({
    openai: null,
    anthropic: null,
    google: null,
    deepseek: null,
    kimi: null,
  });
  const [testError, setTestError] = useState<string | null>(null);

  if (!isOpen) return null;

  const configuredCount = PROVIDERS.filter((p) => config.credentials[p]?.apiKey).length;

  const handleSaveCredential = async (provider: Provider) => {
    if (!apiKeyInput.trim()) return;

    onUpdateCredential(provider, {
      apiKey: apiKeyInput.trim(),
      baseUrl: baseUrlInput.trim() || undefined,
      verified: false,
    });

    setEditingProvider(null);
    setApiKeyInput("");
    setBaseUrlInput("");

    // Auto-test the connection
    await handleTestConnection(provider, apiKeyInput.trim(), baseUrlInput.trim() || undefined);
  };

  const handleTestConnection = async (provider: Provider, apiKey?: string, baseUrl?: string) => {
    const key = apiKey || config.credentials[provider]?.apiKey;
    if (!key) return;

    setTestingProvider(provider);
    setTestError(null);

    try {
      // Build proxy URL if configured
      let proxyUrl = "";
      if (config.proxy.type !== "none" && config.proxy.host && config.proxy.port) {
        const auth = config.proxy.username 
          ? `${config.proxy.username}:${config.proxy.password || ""}@` 
          : "";
        proxyUrl = `${config.proxy.type}://${auth}${config.proxy.host}:${config.proxy.port}`;
      }

      // In a real implementation, this would make actual API calls
      // For now, we'll simulate the test with a delay
      console.log(`Testing ${provider} connection...`, { apiKey: key.slice(0, 10) + "...", baseUrl, proxyUrl });
      
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // For demonstration, we'll check if the API key format looks valid
      const info = PROVIDER_INFO[provider];
      const isValidFormat = key.startsWith(info.keyPrefix) || key.length > 20;

      if (isValidFormat) {
        setTestResults((prev) => ({ ...prev, [provider]: "success" }));
        onUpdateCredential(provider, {
          apiKey: key,
          baseUrl: baseUrl || config.credentials[provider]?.baseUrl,
          verified: true,
          lastTested: Date.now(),
        });
      } else {
        setTestResults((prev) => ({ ...prev, [provider]: "failed" }));
        setTestError(`Invalid API key format for ${info.name}`);
      }
    } catch (error) {
      console.error(`Error testing ${provider}:`, error);
      setTestResults((prev) => ({ ...prev, [provider]: "error" }));
      setTestError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setTestingProvider(null);
    }
  };

  const handleRemoveCredential = (provider: Provider) => {
    onUpdateCredential(provider, null);
    setTestResults((prev) => ({ ...prev, [provider]: null }));
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content w-full max-w-4xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚙️</span>
            <div>
              <h2 className="text-xl font-bold text-white">Settings</h2>
              <p className="text-sm text-gray-400">Configure API keys, proxy, and preferences</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="badge badge-info">{configuredCount}/5 providers</span>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-700 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-700 px-6">
          <nav className="flex gap-1">
            {[
              { id: "api-keys" as TabType, label: "API Keys", icon: "🔑" },
              { id: "models" as TabType, label: "Models", icon: "🤖" },
              { id: "proxy" as TabType, label: "Proxy", icon: "🌐" },
              { id: "preferences" as TabType, label: "Preferences", icon: "⚡" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors
                  ${activeTab === tab.id
                    ? "border-primary text-white"
                    : "border-transparent text-gray-400 hover:text-white hover:border-gray-600"
                  }`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {activeTab === "api-keys" && (
            <div className="space-y-4 scale-in">
              <p className="text-gray-400 text-sm mb-4">
                Configure API keys for each AI provider. Keys are stored locally and never sent to external servers.
              </p>

              {PROVIDERS.map((provider) => {
                const info = PROVIDER_INFO[provider];
                const credential = config.credentials[provider];
                const isConfigured = !!credential?.apiKey;
                const isEditing = editingProvider === provider;
                const isTesting = testingProvider === provider;
                const testResult = testResults[provider];

                return (
                  <div
                    key={provider}
                    className={`bg-gray-800/50 border rounded-xl p-5 transition-all
                      ${isEditing ? "border-primary ring-2 ring-primary/20" : "border-gray-700"}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-4">
                        <div
                          className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl
                            ${isConfigured ? "bg-green-500/10" : "bg-gray-700/50"}`}
                        >
                          {info.avatar}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-white">{info.name}</span>
                            {isConfigured && credential?.verified && (
                              <span className="badge badge-success">Verified ✓</span>
                            )}
                            {isConfigured && !credential?.verified && (
                              <span className="badge badge-warning">Not tested</span>
                            )}
                            {isTesting && (
                              <span className="badge badge-info animate-pulse">Testing...</span>
                            )}
                            {testResult === "failed" && !isTesting && (
                              <span className="badge badge-error">Failed</span>
                            )}
                            {testResult === "error" && !isTesting && (
                              <span className="badge badge-error">Error</span>
                            )}
                          </div>
                          <p className="text-sm text-gray-400 mt-0.5">
                            Used by <span className={info.color}>{info.agent}</span> • {info.description}
                          </p>
                        </div>
                      </div>

                      {!isEditing && (
                        <div className="flex items-center gap-2">
                          {isConfigured ? (
                            <>
                              <button
                                onClick={() => handleTestConnection(provider)}
                                disabled={isTesting}
                                className="text-sm text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded-lg
                                  hover:bg-blue-500/10 transition-colors disabled:opacity-50"
                              >
                                Test
                              </button>
                              <button
                                onClick={() => {
                                  setEditingProvider(provider);
                                  setApiKeyInput("");
                                  setBaseUrlInput(credential?.baseUrl || "");
                                }}
                                className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded-lg
                                  hover:bg-gray-700 transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleRemoveCredential(provider)}
                                className="text-sm text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg
                                  hover:bg-red-500/10 transition-colors"
                              >
                                Remove
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setEditingProvider(provider)}
                              className="text-sm text-primary hover:text-primary/80 px-4 py-1.5 rounded-lg
                                bg-primary/10 hover:bg-primary/20 transition-colors"
                            >
                              Configure
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {isEditing && (
                      <div className="mt-4 pt-4 border-t border-gray-700 space-y-3">
                        <div>
                          <label className="block text-sm text-gray-300 mb-2">
                            API Key:
                          </label>
                          <input
                            type="password"
                            value={apiKeyInput}
                            onChange={(e) => setApiKeyInput(e.target.value)}
                            placeholder={`${info.keyPrefix}...`}
                            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                              text-white placeholder-gray-500 focus:outline-none focus:border-primary
                              focus:ring-2 focus:ring-primary/20 transition-all"
                            autoFocus
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-gray-300 mb-2">
                            Custom Base URL (optional):
                          </label>
                          <input
                            type="text"
                            value={baseUrlInput}
                            onChange={(e) => setBaseUrlInput(e.target.value)}
                            placeholder={info.defaultBaseUrl}
                            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                              text-white placeholder-gray-500 focus:outline-none focus:border-primary
                              focus:ring-2 focus:ring-primary/20 transition-all"
                          />
                        </div>
                        <div className="flex gap-3">
                          <button
                            onClick={() => handleSaveCredential(provider)}
                            disabled={!apiKeyInput.trim()}
                            className="bg-primary hover:bg-primary/90 disabled:bg-gray-600 disabled:cursor-not-allowed
                              text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
                          >
                            Save & Test
                          </button>
                          <button
                            onClick={() => {
                              setEditingProvider(null);
                              setApiKeyInput("");
                              setBaseUrlInput("");
                            }}
                            className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2.5 rounded-lg
                              font-medium transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {testError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
                  <span className="font-medium">Error:</span> {testError}
                </div>
              )}

              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mt-4">
                <div className="flex items-start gap-3">
                  <span className="text-blue-400">🔒</span>
                  <div>
                    <h4 className="text-blue-400 font-medium text-sm">Security Note</h4>
                    <p className="text-blue-300/80 text-sm mt-1">
                      API keys are stored locally in your browser's storage. They are never transmitted to external servers.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "models" && (
            <div className="space-y-4 scale-in">
              <p className="text-gray-400 text-sm mb-4">
                Configure which AI model each council member uses. Different models have different capabilities and pricing.
              </p>

              {PROVIDERS.map((provider) => {
                const info = PROVIDER_INFO[provider];
                const models = MODEL_OPTIONS[provider];
                const currentModel = config.models[provider] || models[0]?.id;

                return (
                  <div
                    key={provider}
                    className="bg-gray-800/50 border border-gray-700 rounded-xl p-5"
                  >
                    <div className="flex items-center gap-4 mb-4">
                      <span className="text-2xl">{info.avatar}</span>
                      <div>
                        <div className={`font-semibold ${info.color}`}>{info.agent}</div>
                        <div className="text-sm text-gray-400">{info.name} models</div>
                      </div>
                    </div>

                    <select
                      value={currentModel}
                      onChange={(e) => onUpdateModel(provider, e.target.value)}
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                        text-white focus:outline-none focus:border-primary transition-colors"
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === "proxy" && (
            <div className="space-y-6 scale-in">
              <p className="text-gray-400 text-sm mb-4">
                Configure a proxy server for API requests. This can help if you're behind a firewall or need to route traffic through a specific server.
              </p>

              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5 space-y-4">
                <div>
                  <label className="block text-sm text-gray-300 mb-2">Proxy Type:</label>
                  <select
                    value={config.proxy.type}
                    onChange={(e) => onUpdateProxy({ ...config.proxy, type: e.target.value as ProxyType })}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                      text-white focus:outline-none focus:border-primary transition-colors"
                  >
                    <option value="none">None (Direct Connection)</option>
                    <option value="http">HTTP Proxy</option>
                    <option value="https">HTTPS Proxy</option>
                    <option value="socks5">SOCKS5 Proxy</option>
                    <option value="socks5h">SOCKS5h Proxy (DNS through proxy)</option>
                  </select>
                </div>

                {config.proxy.type !== "none" && (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">Host:</label>
                        <input
                          type="text"
                          value={config.proxy.host}
                          onChange={(e) => onUpdateProxy({ ...config.proxy, host: e.target.value })}
                          placeholder="127.0.0.1 or proxy.example.com"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                            text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">Port:</label>
                        <input
                          type="number"
                          value={config.proxy.port || ""}
                          onChange={(e) => onUpdateProxy({ ...config.proxy, port: parseInt(e.target.value) || 0 })}
                          placeholder="7897"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                            text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-all"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">Username (optional):</label>
                        <input
                          type="text"
                          value={config.proxy.username || ""}
                          onChange={(e) => onUpdateProxy({ ...config.proxy, username: e.target.value || undefined })}
                          placeholder="Optional"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                            text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">Password (optional):</label>
                        <input
                          type="password"
                          value={config.proxy.password || ""}
                          onChange={(e) => onUpdateProxy({ ...config.proxy, password: e.target.value || undefined })}
                          placeholder="Optional"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                            text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-all"
                        />
                      </div>
                    </div>

                    <div className="text-sm text-gray-500">
                      Current proxy URL: {config.proxy.type}://
                      {config.proxy.username && `${config.proxy.username}:***@`}
                      {config.proxy.host || "host"}:{config.proxy.port || "port"}
                    </div>
                  </>
                )}
              </div>

              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <span className="text-yellow-400">⚠️</span>
                  <div>
                    <h4 className="text-yellow-400 font-medium text-sm">Note</h4>
                    <p className="text-yellow-300/80 text-sm mt-1">
                      Proxy support requires the Tauri backend to handle HTTP requests. 
                      If you're experiencing connection issues, ensure your proxy is properly configured and accessible.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "preferences" && (
            <div className="space-y-6 scale-in">
              {/* Discussion Settings */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                <h3 className="font-medium text-white mb-4">Discussion Settings</h3>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">Show Bidding Scores</div>
                      <div className="text-xs text-gray-400">Display agent bid scores after each round</div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={config.preferences.showBiddingScores}
                        onChange={(e) => onUpdatePreferences({ showBiddingScores: e.target.checked })}
                      />
                      <div className="toggle-slider" />
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">Auto-scroll Messages</div>
                      <div className="text-xs text-gray-400">Automatically scroll to new messages</div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={config.preferences.autoScroll}
                        onChange={(e) => onUpdatePreferences({ autoScroll: e.target.checked })}
                      />
                      <div className="toggle-slider" />
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">Sound Effects</div>
                      <div className="text-xs text-gray-400">Play sounds for new messages and events</div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={config.preferences.soundEffects}
                        onChange={(e) => onUpdatePreferences({ soundEffects: e.target.checked })}
                      />
                      <div className="toggle-slider" />
                    </label>
                  </div>
                </div>
              </div>

              {/* Default Discussion Length */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                <h3 className="font-medium text-white mb-4">Default Discussion Length</h3>
                <select
                  value={config.preferences.defaultLength}
                  onChange={(e) => onUpdatePreferences({ 
                    defaultLength: e.target.value as AppConfig["preferences"]["defaultLength"] 
                  })}
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                    text-white focus:outline-none focus:border-primary transition-colors mb-4"
                >
                  <option value="quick">Quick ({DISCUSSION_LENGTHS.quick} turns)</option>
                  <option value="standard">Standard ({DISCUSSION_LENGTHS.standard} turns)</option>
                  <option value="extended">Extended ({DISCUSSION_LENGTHS.extended} turns)</option>
                  <option value="marathon">Marathon ({DISCUSSION_LENGTHS.marathon} turns)</option>
                  <option value="custom">Custom</option>
                </select>

                {config.preferences.defaultLength === "custom" && (
                  <div>
                    <label className="block text-sm text-gray-300 mb-2">
                      Custom turns (0 = unlimited):
                    </label>
                    <input
                      type="number"
                      value={config.preferences.customTurns}
                      onChange={(e) => onUpdatePreferences({ customTurns: parseInt(e.target.value) || 0 })}
                      min={0}
                      max={10000}
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                        text-white focus:outline-none focus:border-primary transition-all"
                    />
                    {config.preferences.customTurns === 0 && (
                      <p className="text-sm text-yellow-400 mt-2">
                        ⚠️ Unlimited turns - the discussion will continue until manually stopped.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Data Management */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                <h3 className="font-medium text-white mb-4">Data Management</h3>
                <div className="flex flex-wrap gap-3">
                  <button 
                    onClick={() => {
                      const data = JSON.stringify(config, null, 2);
                      const blob = new Blob([data], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "socratic-council-settings.json";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg
                      text-sm transition-colors"
                  >
                    Export Settings
                  </button>
                  <button 
                    onClick={() => {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = ".json";
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (file) {
                          const text = await file.text();
                          try {
                            const imported = JSON.parse(text);
                            // Update each setting category
                            if (imported.credentials) {
                              Object.entries(imported.credentials).forEach(([p, c]) => {
                                onUpdateCredential(p as Provider, c as { apiKey: string });
                              });
                            }
                            if (imported.proxy) onUpdateProxy(imported.proxy);
                            if (imported.preferences) onUpdatePreferences(imported.preferences);
                            if (imported.models) {
                              Object.entries(imported.models).forEach(([p, m]) => {
                                onUpdateModel(p as Provider, m as string);
                              });
                            }
                          } catch (err) {
                            console.error("Failed to import settings:", err);
                          }
                        }
                      };
                      input.click();
                    }}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg
                      text-sm transition-colors"
                  >
                    Import Settings
                  </button>
                  <button 
                    onClick={() => {
                      if (confirm("Are you sure you want to clear all data? This cannot be undone.")) {
                        localStorage.removeItem("socratic-council-config");
                        window.location.reload();
                      }
                    }}
                    className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg
                      text-sm transition-colors"
                  >
                    Clear All Data
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="bg-primary hover:bg-primary/90 text-white px-6 py-2.5 rounded-lg
              font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
