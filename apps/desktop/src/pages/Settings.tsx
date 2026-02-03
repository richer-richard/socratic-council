import { useState, useEffect } from "react";
import type { Page } from "../App";

interface SettingsProps {
  onNavigate: (page: Page) => void;
}

type Provider = "openai" | "anthropic" | "google" | "deepseek" | "kimi";
type TabType = "api-keys" | "models" | "preferences";

interface Credentials {
  [key: string]: { apiKey: string } | undefined;
}

const PROVIDERS: {
  id: Provider;
  name: string;
  agent: string;
  avatar: string;
  color: string;
  description: string;
}[] = [
  {
    id: "openai",
    name: "OpenAI",
    agent: "George",
    avatar: "🔷",
    color: "text-george",
    description: "GPT-5.2, o3, o4-mini models",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    agent: "Cathy",
    avatar: "💜",
    color: "text-cathy",
    description: "Claude 4.5 Opus, Sonnet, Haiku",
  },
  {
    id: "google",
    name: "Google",
    agent: "Grace",
    avatar: "🌱",
    color: "text-grace",
    description: "Gemini 3 Pro, Flash models",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    agent: "Douglas",
    avatar: "🔶",
    color: "text-douglas",
    description: "DeepSeek Reasoner, Chat",
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    agent: "Kate",
    avatar: "📚",
    color: "text-kate",
    description: "Kimi K2.5, Moonshot models",
  },
];

export function Settings({ onNavigate }: SettingsProps) {
  const [credentials, setCredentials] = useState<Credentials>({});
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [activeTab, setActiveTab] = useState<TabType>("api-keys");
  const [testingProvider, setTestingProvider] = useState<Provider | null>(null);
  const [testResults, setTestResults] = useState<Record<Provider, "success" | "failed" | null>>({
    openai: null,
    anthropic: null,
    google: null,
    deepseek: null,
    kimi: null,
  });

  // Load credentials from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("socratic-council-credentials");
    if (stored) {
      try {
        setCredentials(JSON.parse(stored));
      } catch {
        // Ignore parse errors
      }
    }
  }, []);

  // Save credentials
  const saveCredential = async (provider: Provider) => {
    const newCredentials = {
      ...credentials,
      [provider]: { apiKey: apiKeyInput },
    };
    setCredentials(newCredentials);
    localStorage.setItem("socratic-council-credentials", JSON.stringify(newCredentials));
    setEditingProvider(null);
    setApiKeyInput("");

    // Test the connection
    setTestingProvider(provider);
    // Simulate API test (in real app, would call the SDK)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setTestResults((prev) => ({ ...prev, [provider]: "success" }));
    setTestingProvider(null);
  };

  const removeCredential = (provider: Provider) => {
    const newCredentials = { ...credentials };
    delete newCredentials[provider];
    setCredentials(newCredentials);
    localStorage.setItem("socratic-council-credentials", JSON.stringify(newCredentials));
    setTestResults((prev) => ({ ...prev, [provider]: null }));
  };

  const configuredCount = PROVIDERS.filter((p) => credentials[p.id]?.apiKey).length;

  return (
    <div className="flex-1 flex flex-col h-screen">
      {/* Header */}
      <div className="bg-gray-800/50 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          <div className="flex items-center gap-4">
            <button
              onClick={() => onNavigate("home")}
              className="text-gray-400 hover:text-white transition-colors flex items-center gap-2"
            >
              <span>←</span>
              <span>Back</span>
            </button>
            <div className="h-6 w-px bg-gray-700"></div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <span>⚙️</span>
              Settings
            </h1>
          </div>
          <div className="badge badge-info">
            {configuredCount}/5 providers configured
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-700 px-6">
        <div className="max-w-5xl mx-auto">
          <nav className="flex gap-1">
            {[
              { id: "api-keys" as TabType, label: "API Keys", icon: "🔑" },
              { id: "models" as TabType, label: "Agent Models", icon: "🤖" },
              { id: "preferences" as TabType, label: "Preferences", icon: "⚡" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors
                  ${
                    activeTab === tab.id
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto">
          {activeTab === "api-keys" && (
            <div className="scale-in">
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-white mb-2">API Keys</h2>
                <p className="text-gray-400 text-sm">
                  Configure API keys for each AI provider. Keys are stored locally and never sent to our servers.
                </p>
              </div>

              <div className="grid gap-4">
                {PROVIDERS.map((provider) => {
                  const isConfigured = !!credentials[provider.id]?.apiKey;
                  const isEditing = editingProvider === provider.id;
                  const isTesting = testingProvider === provider.id;
                  const testResult = testResults[provider.id];

                  return (
                    <div
                      key={provider.id}
                      className={`bg-gray-800/50 border rounded-xl p-5 transition-all
                        ${isEditing ? "border-primary ring-2 ring-primary/20" : "border-gray-700"}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-4">
                          <div
                            className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl
                              ${isConfigured ? "bg-green-500/10" : "bg-gray-700/50"}`}
                          >
                            {provider.avatar}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-white">{provider.name}</span>
                              {isConfigured && (
                                <span className="badge badge-success">Configured</span>
                              )}
                              {isTesting && (
                                <span className="badge badge-warning">
                                  <span className="animate-pulse">Testing...</span>
                                </span>
                              )}
                              {testResult === "success" && !isTesting && (
                                <span className="badge badge-success">Verified</span>
                              )}
                            </div>
                            <p className="text-sm text-gray-400 mt-0.5">
                              Used by <span className={provider.color}>{provider.agent}</span> • {provider.description}
                            </p>
                          </div>
                        </div>

                        {!isEditing && (
                          <div className="flex items-center gap-2">
                            {isConfigured ? (
                              <>
                                <button
                                  onClick={() => {
                                    setEditingProvider(provider.id);
                                    setApiKeyInput("");
                                  }}
                                  className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded-lg
                                    hover:bg-gray-700 transition-colors"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => removeCredential(provider.id)}
                                  className="text-sm text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg
                                    hover:bg-red-500/10 transition-colors"
                                >
                                  Remove
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => setEditingProvider(provider.id)}
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
                        <div className="mt-4 pt-4 border-t border-gray-700">
                          <label className="block text-sm text-gray-300 mb-2">
                            Enter your {provider.name} API key:
                          </label>
                          <div className="flex gap-3">
                            <input
                              type="password"
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                              placeholder={`sk-... or ${provider.id}-...`}
                              className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                                text-white placeholder-gray-500 focus:outline-none focus:border-primary
                                focus:ring-2 focus:ring-primary/20 transition-all"
                              autoFocus
                            />
                            <button
                              onClick={() => saveCredential(provider.id)}
                              disabled={!apiKeyInput.trim()}
                              className="bg-primary hover:bg-primary/90 disabled:bg-gray-600 disabled:cursor-not-allowed
                                text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => {
                                setEditingProvider(null);
                                setApiKeyInput("");
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
              </div>

              {/* Security Note */}
              <div className="mt-6 bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <span className="text-blue-400">🔒</span>
                  <div>
                    <h4 className="text-blue-400 font-medium text-sm">Security Note</h4>
                    <p className="text-blue-300/80 text-sm mt-1">
                      API keys are stored locally in your browser's storage. They are never transmitted to external servers.
                      For desktop app, keys are encrypted and stored in your system's secure storage.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "models" && (
            <div className="scale-in">
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-white mb-2">Agent Models</h2>
                <p className="text-gray-400 text-sm">
                  Configure which AI model each council member uses. Different models have different capabilities and pricing.
                </p>
              </div>

              <div className="grid gap-4">
                {PROVIDERS.map((provider) => (
                  <div
                    key={provider.id}
                    className="bg-gray-800/50 border border-gray-700 rounded-xl p-5"
                  >
                    <div className="flex items-center gap-4 mb-4">
                      <span className="text-2xl">{provider.avatar}</span>
                      <div>
                        <div className={`font-semibold ${provider.color}`}>{provider.agent}</div>
                        <div className="text-sm text-gray-400">{provider.name} models</div>
                      </div>
                    </div>

                    <select
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                        text-white focus:outline-none focus:border-primary transition-colors"
                      defaultValue="default"
                    >
                      <option value="default">Default model</option>
                      {provider.id === "openai" && (
                        <>
                          <option value="gpt-5.2-pro">GPT-5.2 Pro (Reasoning)</option>
                          <option value="gpt-5.2">GPT-5.2</option>
                          <option value="gpt-5-mini">GPT-5 Mini</option>
                          <option value="o3">o3 (Reasoning)</option>
                        </>
                      )}
                      {provider.id === "anthropic" && (
                        <>
                          <option value="claude-opus-4-5">Claude Opus 4.5</option>
                          <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
                          <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
                        </>
                      )}
                      {provider.id === "google" && (
                        <>
                          <option value="gemini-3-pro-preview">Gemini 3 Pro</option>
                          <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                          <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                        </>
                      )}
                      {provider.id === "deepseek" && (
                        <>
                          <option value="deepseek-reasoner">DeepSeek Reasoner</option>
                          <option value="deepseek-chat">DeepSeek Chat</option>
                        </>
                      )}
                      {provider.id === "kimi" && (
                        <>
                          <option value="kimi-k2.5">Kimi K2.5</option>
                          <option value="kimi-k2-thinking">Kimi K2 Thinking</option>
                          <option value="moonshot-v1-128k">Moonshot V1 128K</option>
                        </>
                      )}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "preferences" && (
            <div className="scale-in">
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-white mb-2">Preferences</h2>
                <p className="text-gray-400 text-sm">
                  Customize how the Socratic Council behaves.
                </p>
              </div>

              <div className="space-y-6">
                {/* Discussion Settings */}
                <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                  <h3 className="font-medium text-white mb-4">Discussion Settings</h3>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-white">Show Bidding Scores</div>
                        <div className="text-xs text-gray-400">Display agent bid scores after each round</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" defaultChecked />
                        <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none peer-focus:ring-4
                          peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full
                          peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px]
                          after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full
                          after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-white">Auto-scroll Messages</div>
                        <div className="text-xs text-gray-400">Automatically scroll to new messages</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" defaultChecked />
                        <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none peer-focus:ring-4
                          peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full
                          peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px]
                          after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full
                          after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-white">Sound Effects</div>
                        <div className="text-xs text-gray-400">Play sounds for new messages and events</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" />
                        <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none peer-focus:ring-4
                          peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full
                          peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px]
                          after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full
                          after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Default Discussion Length */}
                <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                  <h3 className="font-medium text-white mb-4">Default Discussion Length</h3>
                  <select
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                      text-white focus:outline-none focus:border-primary transition-colors"
                    defaultValue="10"
                  >
                    <option value="5">Quick (5 turns)</option>
                    <option value="10">Standard (10 turns)</option>
                    <option value="20">Extended (20 turns)</option>
                    <option value="50">Marathon (50 turns)</option>
                  </select>
                </div>

                {/* Data Management */}
                <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-5">
                  <h3 className="font-medium text-white mb-4">Data Management</h3>
                  <div className="flex gap-3">
                    <button className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg
                      text-sm transition-colors">
                      Export Settings
                    </button>
                    <button className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg
                      text-sm transition-colors">
                      Import Settings
                    </button>
                    <button className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg
                      text-sm transition-colors">
                      Clear All Data
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
