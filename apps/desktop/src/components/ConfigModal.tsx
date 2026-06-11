import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Provider,
  type ProxyType,
  type AppConfig,
  type ProxyConfig,
  type ReasoningTier,
  PROVIDER_INFO,
  LOCKED_MODELS,
  DISCUSSION_LENGTHS,
  REASONING_TIER_OPTIONS,
  availableModelsForProvider,
  isProvider,
} from "../stores/config";
import {
  AUTO_MODEL,
  REASONING_TIERS,
  resolveModel,
  type AgentId,
  type DiscoveredModel,
} from "@socratic-council/shared";
import { ProviderIcon } from "./icons/ProviderIcons";
import { testProviderConnection } from "../services/api";
import { scanProviderModels, getCachedScan, type ScanResult } from "../services/modelScan";
import { clearAllAttachmentBlobs } from "../services/attachments";
// Single source of truth for the version + identifier shown in the About
// tab. Reading from the desktop package.json means a version bump in a
// new release commit (e.g. v2.1.0 → v2.1.1) is automatically reflected
// here at build time — no separate constant to forget to update.
import desktopPkg from "../../package.json";

// Stroked SVG icons in the same visual language as the Chat header
// (HeaderIconLogs / HeaderIconSearch / etc.) — 16x16 viewBox, 1.4 stroke,
// currentColor. Replaces the emoji set that broke the cinematic-dark
// aesthetic.
function IconGear() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.7 M8 12.8v1.7 M14.5 8h-1.7 M3.2 8H1.5 M12.6 3.4l-1.2 1.2 M4.6 11.4l-1.2 1.2 M12.6 12.6l-1.2-1.2 M4.6 4.6L3.4 3.4" />
    </svg>
  );
}
function IconKey() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="8" r="2.4" />
      <path d="M7.4 8h6.6 M11.4 8v2.2 M13.6 8v2.6" />
    </svg>
  );
}
function IconChip() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.4" />
      <line x1="8" y1="1.5" x2="8" y2="3.8" />
      <line x1="8" y1="12.2" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="3.8" y2="8" />
      <line x1="12.2" y1="8" x2="14.5" y2="8" />
      <line x1="5.6" y1="1.5" x2="5.6" y2="3.8" />
      <line x1="10.4" y1="12.2" x2="10.4" y2="14.5" />
      <line x1="1.5" y1="10.4" x2="3.8" y2="10.4" />
      <line x1="12.2" y1="5.6" x2="14.5" y2="5.6" />
    </svg>
  );
}
function IconGlobe() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6" />
      <line x1="2" y1="8" x2="14" y2="8" />
    </svg>
  );
}
function IconSliders() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
      <circle cx="6" cy="4.5" r="1.4" fill="var(--config-bg, #111)" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <circle cx="10.5" cy="8" r="1.4" fill="var(--config-bg, #111)" />
      <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
      <circle cx="5" cy="11.5" r="1.4" fill="var(--config-bg, #111)" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="7.2" x2="8" y2="11.5" />
      <circle cx="8" cy="4.6" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

/**
 * Custom dropdown that replaces the native <select>. Tauri renders the OS
 * default popup which fights the cinematic-dark theme; this listbox
 * panel inherits the same gold-on-dark palette as the rest of the app.
 */
function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);

  return (
    <div ref={containerRef} className="app-dropdown">
      <button
        type="button"
        className="app-dropdown-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="app-dropdown-value">{current?.label ?? value}</span>
        <span className={`app-dropdown-caret ${open ? "is-open" : ""}`}>
          <IconChevronDown />
        </span>
      </button>
      {open && (
        <ul className="app-dropdown-panel" role="listbox" tabIndex={-1}>
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value}>
              <button
                type="button"
                className={`app-dropdown-item ${option.value === value ? "is-selected" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onUpdateCredential: (
    provider: Provider,
    credential: {
      apiKey: string;
      baseUrl?: string;
      verified?: boolean;
      lastTested?: number;
    } | null,
  ) => void;
  onUpdateProxy: (proxy: AppConfig["proxy"]) => void;
  onUpdatePreferences: (preferences: Partial<AppConfig["preferences"]>) => void;
  onUpdateModel: (provider: Provider, model: string) => void;
  /** Per-provider, per-tier model selection. */
  onUpdateModelSelection: (provider: Provider, tier: ReasoningTier, model: string) => void;
  /** Reasoning tier a character debates at. */
  onUpdateAgentTier: (agentId: AgentId, tier: ReasoningTier) => void;
  onUpdateCouncilTier: (tier: ReasoningTier) => void;
  onUpdateUtilityTier: (tier: ReasoningTier) => void;
  /** Called after a successful live scan so the store re-resolves models. */
  onModelsScanned: () => void;
  /** Resolved proxy (for routing scan requests). */
  proxy?: ProxyConfig;
  vaultReady: boolean;
}

type TabType = "api-keys" | "models" | "proxy" | "preferences" | "diagnostics" | "about";

const PROVIDERS = Object.keys(PROVIDER_INFO) as Provider[];

/** Which inner-circle character runs on each provider. */
const PROVIDER_AGENT_ID: Record<Provider, AgentId> = {
  openai: "george",
  anthropic: "cathy",
  google: "grace",
  deepseek: "douglas",
  kimi: "kate",
  qwen: "quinn",
  minimax: "mary",
  zhipu: "zara",
};

function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const ABOUT_VERSION = desktopPkg.version;
const ABOUT_IDENTIFIER = "com.socratic-council.desktop";
const ABOUT_LICENSE = "Apache-2.0";
const ABOUT_REPOSITORY = "https://github.com/richer-richard/socratic-council";
const ABOUT_SHORTCUTS = [
  { keys: "Cmd+K", description: "Open the command palette" },
  { keys: "Cmd+O", description: "Attach files to a new session" },
  { keys: "Shift+Cmd+O", description: "Choose photos from the Mac picker" },
  { keys: "Shift+Cmd+C", description: "Open the camera capture sheet" },
  { keys: "Cmd+,", description: "Open Settings" },
  { keys: "Esc", description: "Close the current modal or attachment menu" },
  { keys: "Delete", description: "Remove the focused attachment chip on the home screen" },
];

/**
 * Map a raw provider-test error into something the user can act on. The
 * default branch passes through the original error text so unknown failure
 * modes still surface — categorization is purely additive guidance.
 */
function mapTestConnectionError(provider: Provider, error: unknown): string {
  const info = PROVIDER_INFO[provider];
  const name = provider === "kimi" ? "Kimi" : info.name;
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return `${name} rejected this key. Double-check it at ${info.signupUrl}.`;
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("too many requests")
  ) {
    return `${name} is rate-limiting requests. Wait a minute and retry.`;
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("connection failed")
  ) {
    return `Couldn't reach ${name} — check your proxy or internet connection.`;
  }
  if (
    /\b5\d{2}\b/.test(raw) ||
    lower.includes("server error") ||
    lower.includes("internal error")
  ) {
    return `${name} is having issues server-side. Try again in a few minutes.`;
  }
  return `Test failed: ${raw}`;
}

export function ConfigModal({
  isOpen,
  onClose,
  config,
  onUpdateCredential,
  onUpdateProxy,
  onUpdatePreferences,
  onUpdateModel,
  onUpdateModelSelection,
  onUpdateAgentTier,
  onUpdateCouncilTier,
  onUpdateUtilityTier,
  onModelsScanned,
  proxy,
  vaultReady,
}: ConfigModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>("api-keys");
  // Scan status per provider + a counter bumped after each scan so the
  // available-model lists (read from localStorage) recompute.
  const [scanStatus, setScanStatus] = useState<
    Partial<Record<Provider, { status: "scanning" | "ok" | "error"; result?: ScanResult }>>
  >({});
  const [modelsVersion, setModelsVersion] = useState(0);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [testingProvider, setTestingProvider] = useState<Provider | null>(null);
  const [testResults, setTestResults] = useState<
    Record<Provider, "success" | "failed" | "error" | null>
  >({
    openai: null,
    anthropic: null,
    google: null,
    deepseek: null,
    kimi: null,
    qwen: null,
    minimax: null,
    zhipu: null,
  });
  const [testError, setTestError] = useState<string | null>(null);

  // Available models per provider (live scan ∪ catalog), recomputed after a scan.
  // Must sit above the early return: hooks can never be conditional.
  const availableByProvider = useMemo(() => {
    const map = {} as Record<Provider, DiscoveredModel[]>;
    for (const provider of PROVIDERS) map[provider] = availableModelsForProvider(provider);
    return map;
    // modelsVersion/isOpen are the recompute triggers; the body reads only stable module refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsVersion, isOpen]);

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
      const success = await testProviderConnection(
        provider,
        { apiKey: key, baseUrl },
        config.proxy,
      );

      if (success) {
        setTestResults((prev) => ({ ...prev, [provider]: "success" }));
        onUpdateCredential(provider, {
          apiKey: key,
          baseUrl: baseUrl || config.credentials[provider]?.baseUrl,
          verified: true,
          lastTested: Date.now(),
        });
      } else {
        setTestResults((prev) => ({ ...prev, [provider]: "failed" }));
        const providerName = provider === "kimi" ? "Kimi" : PROVIDER_INFO[provider].name;
        setTestError(`Connection test failed for ${providerName}`);
      }
    } catch (error) {
      console.error(`Error testing ${provider}:`, error);
      setTestResults((prev) => ({ ...prev, [provider]: "error" }));
      setTestError(mapTestConnectionError(provider, error));
    } finally {
      setTestingProvider(null);
    }
  };

  const handleRemoveCredential = (provider: Provider) => {
    onUpdateCredential(provider, null);
    setTestResults((prev) => ({ ...prev, [provider]: null }));
  };

  const handleScan = async (provider: Provider) => {
    const credential = config.credentials[provider];
    if (!credential?.apiKey) return;
    setScanStatus((prev) => ({ ...prev, [provider]: { status: "scanning" } }));
    const result = await scanProviderModels(provider, credential, proxy);
    setScanStatus((prev) => ({
      ...prev,
      [provider]: { status: result.ok ? "ok" : "error", result },
    }));
    setModelsVersion((v) => v + 1);
    onModelsScanned();
  };

  const handleScanAll = async () => {
    const configured = PROVIDERS.filter((p) => config.credentials[p]?.apiKey);
    await Promise.all(configured.map((p) => handleScan(p)));
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content config-modal w-full max-w-4xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <span
              className="config-modal-icon"
              style={{ display: "inline-flex", color: "rgba(245, 197, 66, 0.85)" }}
            >
              <IconGear />
            </span>
            <div>
              <h2 className="text-xl font-bold text-white">Settings</h2>
              <p className="text-sm text-gray-400">Configure API keys, proxy, and preferences</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="badge badge-info">
              {configuredCount}/{PROVIDERS.length} providers
            </span>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-700 transition-colors"
              aria-label="Close settings"
            >
              <IconClose />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-700 px-6">
          <nav className="flex gap-1">
            {[
              { id: "api-keys" as TabType, label: "API Keys", Icon: IconKey },
              { id: "models" as TabType, label: "Models", Icon: IconChip },
              { id: "proxy" as TabType, label: "Proxy", Icon: IconGlobe },
              { id: "preferences" as TabType, label: "Preferences", Icon: IconSliders },
              { id: "about" as TabType, label: "About", Icon: IconInfo },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors
                  inline-flex items-center gap-2
                  ${
                    activeTab === tab.id
                      ? "border-primary text-white"
                      : "border-transparent text-gray-400 hover:text-white hover:border-gray-600"
                  }`}
              >
                <tab.Icon />
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
                Configure API keys for each AI provider. Keys are stored locally and never sent to
                external servers.
              </p>

              {PROVIDERS.map((provider) => {
                const info = PROVIDER_INFO[provider];
                const credential = config.credentials[provider];
                const isConfigured = !!credential?.apiKey;
                const isEditing = editingProvider === provider;
                const isTesting = testingProvider === provider;
                const testResult = testResults[provider];
                const providerName = provider === "kimi" ? "Kimi" : info.name;

                return (
                  <div
                    key={provider}
                    className={`settings-card transition-all ${
                      isEditing ? "settings-card-editing" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-4">
                        <div
                          className={`w-12 h-12 rounded-xl flex items-center justify-center
                            ${isConfigured ? "bg-green-500/10" : "bg-gray-700/50"}`}
                        >
                          <ProviderIcon provider={provider} size={32} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-white">{providerName}</span>
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
                            Used by <span className={info.color}>{info.agent}</span> ·{" "}
                            <code className="text-gray-300">
                              {config.models[provider] ?? LOCKED_MODELS[provider]}
                            </code>
                          </p>
                        </div>
                      </div>

                      {!isEditing && (
                        <div className="flex items-center gap-2">
                          <a
                            href={info.signupUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-gray-400 hover:text-primary px-2 py-1.5 transition-colors whitespace-nowrap"
                            title={`Open ${providerName} API key page`}
                          >
                            Get a key →
                          </a>
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
                          <label className="block text-sm text-gray-300 mb-2">API Key:</label>
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
                      API keys are encrypted at rest with XChaCha20-Poly1305 and stored in
                      <code className="mx-1 text-blue-200/90">
                        ~/Library/Application Support/com.socratic-council.desktop/
                      </code>
                      . They are only sent to the provider's API endpoint when you start a
                      discussion, and are never transmitted to any third party.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "models" && (
            <div className="space-y-4 scale-in">
              {/* Intro + global reasoning levels */}
              <div className="settings-card">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="font-medium text-white mb-1">Models &amp; reasoning levels</h3>
                    <p className="text-sm text-gray-400 max-w-2xl">
                      Choose a model for each reasoning level, or leave it on{" "}
                      <span className="text-primary">Auto</span> to always use the best available —
                      newer flagships are adopted automatically once you scan. Scanning queries each
                      provider&apos;s own endpoint with your key (Chinese endpoints for Chinese
                      models).
                    </p>
                  </div>
                  <button
                    onClick={handleScanAll}
                    disabled={!vaultReady || configuredCount === 0}
                    className="bg-primary/10 hover:bg-primary/20 disabled:opacity-40 text-primary
                      px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-colors"
                  >
                    ⟳ Scan all keys
                  </button>
                </div>
                <div className="grid sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-gray-400 mb-2">
                      Debate reasoning level
                    </label>
                    <Dropdown<ReasoningTier>
                      value={config.councilTier}
                      onChange={onUpdateCouncilTier}
                      ariaLabel="Debate reasoning level"
                      options={REASONING_TIER_OPTIONS.map((t) => ({
                        value: t.value,
                        label: `${t.label} — ${t.hint}`,
                      }))}
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-gray-400 mb-2">
                      Background tasks
                    </label>
                    <Dropdown<ReasoningTier>
                      value={config.utilityTier}
                      onChange={onUpdateUtilityTier}
                      ariaLabel="Background task reasoning level"
                      options={REASONING_TIER_OPTIONS.map((t) => ({
                        value: t.value,
                        label: `${t.label} — ${t.hint}`,
                      }))}
                    />
                  </div>
                </div>
              </div>

              {PROVIDERS.map((provider) => {
                const info = PROVIDER_INFO[provider];
                const agentId = PROVIDER_AGENT_ID[provider];
                const available = availableByProvider[provider];
                const status = scanStatus[provider];
                const cached = getCachedScan(provider);
                const hasKey = !!config.credentials[provider]?.apiKey;
                const agentTier = config.agentTiers[agentId] ?? config.councilTier;

                const modelOptions = [
                  { value: AUTO_MODEL, label: "Auto (best available)" },
                  ...available.map((m) => ({
                    value: m.id,
                    label:
                      m.displayName && m.displayName !== m.id ? `${m.displayName} · ${m.id}` : m.id,
                  })),
                ];

                return (
                  <div key={provider} className="settings-card">
                    <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <ProviderIcon provider={provider} size={28} />
                        <div className="min-w-0">
                          <div className={`font-semibold ${info.color}`}>{info.agent}</div>
                          <div className="text-xs text-gray-400 truncate">{info.name}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-500">
                          {status?.status === "scanning"
                            ? "Scanning…"
                            : cached
                              ? `${cached.models.length} models · scanned ${relativeTime(
                                  cached.scannedAt,
                                )}`
                              : `${available.length} catalog models`}
                        </span>
                        <button
                          onClick={() => handleScan(provider)}
                          disabled={!hasKey || !vaultReady || status?.status === "scanning"}
                          className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40
                            px-3 py-1.5 rounded-lg hover:bg-blue-500/10 transition-colors"
                          title={
                            hasKey
                              ? `Scan ${info.name} for available models`
                              : "Add an API key first"
                          }
                        >
                          {status?.status === "scanning" ? "Scanning…" : "⟳ Scan"}
                        </button>
                      </div>
                    </div>

                    {status?.status === "error" && status.result?.error && (
                      <div className="text-xs text-yellow-400/90 mb-3">{status.result.error}</div>
                    )}

                    <div className="space-y-2">
                      {REASONING_TIERS.map((tier) => {
                        const selection = config.modelSelection[provider]?.[tier] ?? AUTO_MODEL;
                        const resolved = resolveModel(provider, tier, available, selection);
                        const tierLabel =
                          REASONING_TIER_OPTIONS.find((t) => t.value === tier)?.label ?? tier;
                        const isDebateTier = tier === agentTier;
                        return (
                          <div key={tier} className="flex items-center gap-3">
                            <div className="w-16 shrink-0 text-sm text-gray-300 flex items-center gap-1">
                              {tierLabel}
                              {isDebateTier && (
                                <span
                                  className="text-primary"
                                  title="This character debates at this level"
                                >
                                  ●
                                </span>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <Dropdown<string>
                                value={selection}
                                ariaLabel={`${info.agent} ${tierLabel} model`}
                                onChange={(next) => onUpdateModelSelection(provider, tier, next)}
                                options={modelOptions}
                              />
                            </div>
                            <div
                              className="w-40 shrink-0 text-xs text-gray-500 truncate text-right"
                              title={resolved}
                            >
                              {selection === AUTO_MODEL ? `→ ${resolved}` : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-4 flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-400">{info.agent} debates at:</span>
                      {REASONING_TIER_OPTIONS.map((t) => (
                        <button
                          key={t.value}
                          onClick={() => onUpdateAgentTier(agentId, t.value)}
                          className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                            agentTier === t.value
                              ? "border-primary text-primary bg-primary/10"
                              : "border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === "proxy" && (
            <div className="space-y-6 scale-in">
              <p className="text-gray-400 text-sm mb-4">
                Configure a proxy server for API requests. This applies to{" "}
                <strong>all providers</strong> uniformly. Use this if you're behind a firewall or
                need to route traffic through a specific server.
              </p>

              <div className="settings-card space-y-4">
                <div>
                  <label className="block text-sm text-gray-300 mb-2">Proxy Type:</label>
                  <Dropdown<ProxyType>
                    value={config.proxy.type}
                    onChange={(next) => onUpdateProxy({ ...config.proxy, type: next })}
                    ariaLabel="Proxy type"
                    options={[
                      { value: "none", label: "None (Direct Connection)" },
                      { value: "http", label: "HTTP Proxy" },
                      { value: "https", label: "HTTPS Proxy" },
                      { value: "socks5", label: "SOCKS5 Proxy" },
                      { value: "socks5h", label: "SOCKS5h Proxy (DNS through proxy)" },
                    ]}
                  />
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
                          onChange={(e) =>
                            onUpdateProxy({ ...config.proxy, port: parseInt(e.target.value) || 0 })
                          }
                          placeholder="7897"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                            text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-all"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">
                          Username (optional):
                        </label>
                        <input
                          type="text"
                          value={config.proxy.username || ""}
                          onChange={(e) =>
                            onUpdateProxy({
                              ...config.proxy,
                              username: e.target.value || undefined,
                            })
                          }
                          placeholder="Optional"
                          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5
                            text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">
                          Password (optional):
                        </label>
                        <input
                          type="password"
                          value={config.proxy.password || ""}
                          onChange={(e) =>
                            onUpdateProxy({
                              ...config.proxy,
                              password: e.target.value || undefined,
                            })
                          }
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
                      Proxy support requires the Tauri backend to handle HTTP requests. If you're
                      experiencing connection issues, ensure your proxy is properly configured and
                      accessible. The proxy setting applies to all API providers uniformly.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "preferences" && (
            <div className="space-y-6 scale-in">
              {/* Discussion Settings */}
              <div className="settings-card">
                <h3 className="font-medium text-white mb-4">Discussion Settings</h3>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">Show Bidding Scores</div>
                      <div className="text-xs text-gray-400">
                        Display agent bid scores after each round
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={config.preferences.showBiddingScores}
                        onChange={(e) =>
                          onUpdatePreferences({ showBiddingScores: e.target.checked })
                        }
                      />
                      <div className="toggle-slider" />
                    </label>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">Auto-scroll Messages</div>
                      <div className="text-xs text-gray-400">
                        Automatically scroll to new messages
                      </div>
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
                      <div className="text-sm text-white">Moderator Agent</div>
                      <div className="text-xs text-gray-400">
                        Adds occasional moderator notes to keep the discussion focused
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={config.preferences.moderatorEnabled}
                        onChange={(e) =>
                          onUpdatePreferences({ moderatorEnabled: e.target.checked })
                        }
                      />
                      <div className="toggle-slider" />
                    </label>
                  </div>
                </div>
              </div>

              {/* Discussion cap */}
              <div className="settings-card">
                <h3 className="font-medium text-white mb-1">Default discussion cap</h3>
                <p className="text-xs text-gray-400 mb-4">
                  New sessions inherit this cap at creation. Existing sessions keep their original
                  limit unless you adjust it from the chat header.
                </p>
                <Dropdown<AppConfig["preferences"]["defaultLength"]>
                  value={config.preferences.defaultLength}
                  onChange={(next) => onUpdatePreferences({ defaultLength: next })}
                  ariaLabel="Default discussion cap"
                  options={[
                    {
                      value: "quick",
                      label: `Quick (3 rounds · ${DISCUSSION_LENGTHS.quick} turns)`,
                    },
                    {
                      value: "standard",
                      label: `Standard (5 rounds · ${DISCUSSION_LENGTHS.standard} turns)`,
                    },
                    {
                      value: "extended",
                      label: `Extended (10 rounds · ${DISCUSSION_LENGTHS.extended} turns)`,
                    },
                    { value: "marathon", label: "Marathon (no cap)" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
                <div className="mb-4" />

                {config.preferences.defaultLength === "custom" && (
                  <div>
                    <label className="block text-sm text-gray-300 mb-2">
                      Custom turns (0 = unlimited):
                    </label>
                    <input
                      type="number"
                      value={config.preferences.customTurns}
                      onChange={(e) =>
                        onUpdatePreferences({ customTurns: parseInt(e.target.value) || 0 })
                      }
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
              <div className="settings-card">
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
                                if (isProvider(p)) {
                                  onUpdateCredential(p, c as { apiKey: string });
                                }
                              });
                            }
                            if (imported.proxy) onUpdateProxy(imported.proxy);
                            if (imported.preferences) onUpdatePreferences(imported.preferences);
                            if (imported.models) {
                              Object.entries(imported.models).forEach(([p, m]) => {
                                if (isProvider(p)) {
                                  onUpdateModel(p, m as string);
                                }
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
                    onClick={async () => {
                      if (
                        !confirm(
                          "Are you sure you want to clear all local data? This cannot be undone.",
                        )
                      ) {
                        return;
                      }

                      const appKeys = Object.keys(localStorage).filter((key) =>
                        key.startsWith("socratic-council-"),
                      );
                      for (const key of appKeys) {
                        localStorage.removeItem(key);
                      }
                      try {
                        await clearAllAttachmentBlobs();
                      } catch (error) {
                        console.error("Failed to clear attachment database:", error);
                      }
                      window.location.reload();
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

          {activeTab === "about" && (
            <div className="space-y-6 scale-in">
              <div className="settings-card">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h3 className="font-medium text-white">Socratic Council Desktop</h3>
                    <p className="text-sm text-gray-400 mt-2 max-w-2xl">
                      Local-first multi-agent debate workstation for running, resuming, archiving,
                      and now attaching source material to a new council session.
                    </p>
                  </div>
                  <div className="badge badge-info">v{ABOUT_VERSION}</div>
                </div>

                <div className="grid md:grid-cols-2 gap-4 mt-5">
                  <div className="settings-subcard">
                    <div className="text-xs text-gray-400 uppercase tracking-[0.18em]">
                      Bundle Identifier
                    </div>
                    <div className="text-sm text-white mt-2">{ABOUT_IDENTIFIER}</div>
                  </div>
                  <div className="settings-subcard">
                    <div className="text-xs text-gray-400 uppercase tracking-[0.18em]">License</div>
                    <div className="text-sm text-white mt-2">{ABOUT_LICENSE}</div>
                  </div>
                  <div className="settings-subcard md:col-span-2">
                    <div className="text-xs text-gray-400 uppercase tracking-[0.18em]">
                      Repository
                    </div>
                    <a
                      href={ABOUT_REPOSITORY}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-blue-400 hover:text-blue-300 mt-2 inline-flex"
                    >
                      {ABOUT_REPOSITORY}
                    </a>
                  </div>
                </div>
              </div>

              <div className="settings-card">
                <h3 className="font-medium text-white mb-4">Local Data and Attachments</h3>
                <div className="space-y-3 text-sm text-gray-400">
                  <p>Sessions, API settings, and attachment metadata stay on this machine.</p>
                  <p>
                    Image and PDF blobs are stored outside localStorage so recent sessions can keep
                    attached source material without inflating the session index.
                  </p>
                  <p>
                    Images are optimized locally before upload. PDFs are converted into compact
                    searchable notes by default so large documents do not flood model context on
                    every turn.
                  </p>
                  <p>
                    Camera capture relies on macOS camera permission. If access is denied, the home
                    screen camera sheet will tell you before anything is attached.
                  </p>
                </div>
              </div>

              <div className="settings-card">
                <h3 className="font-medium text-white mb-4">Shortcuts</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  {ABOUT_SHORTCUTS.map((shortcut) => (
                    <div key={shortcut.keys} className="settings-subcard">
                      <div className="text-sm text-white font-medium">{shortcut.keys}</div>
                      <div className="text-sm text-gray-400 mt-1">{shortcut.description}</div>
                    </div>
                  ))}
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
