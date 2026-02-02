import { useState, useEffect } from "react";
import type { Page } from "../App";

interface SettingsProps {
  onNavigate: (page: Page) => void;
}

type Provider = "openai" | "anthropic" | "google" | "deepseek" | "kimi";

interface Credentials {
  [key: string]: { apiKey: string } | undefined;
}

const PROVIDERS: { id: Provider; name: string; agent: string }[] = [
  { id: "openai", name: "OpenAI", agent: "George" },
  { id: "anthropic", name: "Anthropic", agent: "Cathy" },
  { id: "google", name: "Google", agent: "Grace" },
  { id: "deepseek", name: "DeepSeek", agent: "Douglas" },
  { id: "kimi", name: "Kimi (Moonshot)", agent: "Kate" },
];

export function Settings({ onNavigate }: SettingsProps) {
  const [credentials, setCredentials] = useState<Credentials>({});
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");

  // Load credentials from localStorage (in Tauri, would use store plugin)
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
  const saveCredential = (provider: Provider) => {
    const newCredentials = {
      ...credentials,
      [provider]: { apiKey: apiKeyInput },
    };
    setCredentials(newCredentials);
    localStorage.setItem("socratic-council-credentials", JSON.stringify(newCredentials));
    setEditingProvider(null);
    setApiKeyInput("");
  };

  const removeCredential = (provider: Provider) => {
    const newCredentials = { ...credentials };
    delete newCredentials[provider];
    setCredentials(newCredentials);
    localStorage.setItem("socratic-council-credentials", JSON.stringify(newCredentials));
  };

  return (
    <div className="flex-1 flex flex-col p-8">
      {/* Header */}
      <div className="flex items-center mb-8">
        <button
          onClick={() => onNavigate("home")}
          className="text-gray-400 hover:text-white mr-4"
        >
          ← Back
        </button>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      {/* API Keys Section */}
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-white mb-4">API Keys</h2>
        <p className="text-gray-400 text-sm mb-6">
          Configure API keys for each provider. Keys are stored locally on your device.
        </p>

        <div className="space-y-4">
          {PROVIDERS.map((provider) => {
            const isConfigured = !!credentials[provider.id]?.apiKey;
            const isEditing = editingProvider === provider.id;

            return (
              <div
                key={provider.id}
                className="bg-gray-800 rounded-lg p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white">{provider.name}</div>
                    <div className="text-sm text-gray-400">
                      Used by {provider.agent}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isConfigured && !isEditing ? (
                      <>
                        <span className="text-green-400 text-sm">✓ Configured</span>
                        <button
                          onClick={() => {
                            setEditingProvider(provider.id);
                            setApiKeyInput(credentials[provider.id]?.apiKey ?? "");
                          }}
                          className="text-gray-400 hover:text-white text-sm"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => removeCredential(provider.id)}
                          className="text-red-400 hover:text-red-300 text-sm"
                        >
                          Remove
                        </button>
                      </>
                    ) : isEditing ? null : (
                      <button
                        onClick={() => setEditingProvider(provider.id)}
                        className="text-primary hover:text-primary/80 text-sm"
                      >
                        Configure
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <div className="mt-4 flex gap-2">
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={`Enter ${provider.name} API key`}
                      className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-primary"
                    />
                    <button
                      onClick={() => saveCredential(provider.id)}
                      disabled={!apiKeyInput.trim()}
                      className="bg-primary hover:bg-primary/90 disabled:bg-gray-600 text-white px-4 py-2 rounded text-sm"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingProvider(null);
                        setApiKeyInput("");
                      }}
                      className="bg-gray-600 hover:bg-gray-500 text-white px-4 py-2 rounded text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
