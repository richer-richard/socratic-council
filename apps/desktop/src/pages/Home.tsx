import { useEffect, useMemo, useState } from "react";

import { CouncilMark } from "../components/CouncilMark";
import { ConfigModal } from "../components/ConfigModal";
import { Starfield } from "../components/Starfield";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import type { SessionSummary, SessionStatus } from "../services/sessions";
import { useConfig, getShuffledTopics, PROVIDER_INFO, type Provider } from "../stores/config";

interface HomeProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onArchiveSession: (sessionId: string) => void;
  onCreateSession: (topic: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onRestoreSession: (sessionId: string) => void;
}

type SessionFolder = "recent" | "archived";

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
  { provider: "qwen", name: "Quinn", color: "var(--color-quinn)" },
  { provider: "minimax", name: "Mary", color: "var(--color-mary)" },
];

const STATUS_LABELS: Record<SessionStatus, string> = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  completed: "Complete",
};

function GearIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 8v1m0 6v1m4-4h-1m-6 0H8m5.66 2.66l-.71.71m-3.9-3.9l-.71.71m4.61 0l.71.71m-3.9 3.9l.71.71" />
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ArchiveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function ArrowIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function RestoreIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a8 8 0 0 1-14-5.2V7" />
      <path d="M7 7a8 8 0 0 1 13.65 2.35" />
    </svg>
  );
}

function MoreIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = timestamp - Date.now();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function Home({
  sessions,
  activeSessionId,
  onArchiveSession,
  onCreateSession,
  onDeleteSession,
  onOpenSession,
  onRestoreSession,
}: HomeProps) {
  const [topic, setTopic] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [showArchivedEmptyNotice, setShowArchivedEmptyNotice] = useState(false);
  const [sessionFolder, setSessionFolder] = useState<SessionFolder>("recent");
  const [pendingSessionAction, setPendingSessionAction] = useState<SessionSummary | null>(null);
  const {
    config,
    updateCredential,
    updateProxy,
    updatePreferences,
    updateModel,
    hasAnyApiKey,
    getConfiguredProviders,
  } = useConfig();

  const configuredProviders = getConfiguredProviders();
  const sampleTopics = useMemo(() => getShuffledTopics(5), []);
  const recentSessions = useMemo(
    () => sessions.filter((session) => session.archivedAt == null),
    [sessions]
  );
  const archivedSessions = useMemo(
    () =>
      [...sessions]
        .filter((session) => session.archivedAt != null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [sessions]
  );
  const visibleSessions = sessionFolder === "archived" ? archivedSessions : recentSessions;
  const isArchivedActionTarget = pendingSessionAction?.archivedAt != null;

  const handleStart = () => {
    if (!topic.trim()) return;
    if (!hasAnyApiKey()) {
      setShowApiWarning(true);
      return;
    }

    onCreateSession(topic.trim());
  };

  const handleSelectSessionFolder = (folder: SessionFolder) => {
    if (folder === "archived" && archivedSessions.length === 0) {
      setShowArchivedEmptyNotice(true);
      return;
    }

    setSessionFolder(folder);
  };

  useEffect(() => {
    if (sessionFolder === "archived" && archivedSessions.length === 0) {
      setSessionFolder("recent");
    }
  }, [archivedSessions.length, sessionFolder]);

  useEffect(() => {
    if (!pendingSessionAction) return;

    const stillExists = sessions.some((session) => session.id === pendingSessionAction.id);
    if (!stillExists) {
      setPendingSessionAction(null);
    }
  }, [pendingSessionAction, sessions]);

  return (
    <div className="app-shell workstation-shell flex-1 overflow-hidden relative">
      <div className="ambient-canvas" aria-hidden="true" />
      <Starfield />

      <aside className="workstation-sidebar">
        <div className="workstation-brand">
          <div className="workstation-brand-mark">
            <CouncilMark size={36} />
          </div>
          <div>
            <div className="workstation-brand-label">Socratic Council</div>
            <div className="workstation-brand-subtitle">Local Workstation</div>
          </div>
        </div>

        <div className="workstation-sidebar-actions">
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="workstation-sidebar-button"
          >
            <GearIcon size={16} />
            <span>Settings</span>
          </button>
          <div className="workstation-sidebar-pill">
            <ArchiveIcon size={14} />
            <span>{sessions.length} saved locally</span>
          </div>
        </div>

        <div className="workstation-sidebar-section">
          <div className="workstation-sidebar-header">
            <div className="workstation-sidebar-heading">
              {sessionFolder === "recent" ? "Recent Sessions" : "Archived Sessions"}
            </div>
            <div className="workstation-session-view" role="tablist" aria-label="Session folders">
              <button
                type="button"
                role="tab"
                aria-selected={sessionFolder === "recent"}
                className={`workstation-session-view-button ${sessionFolder === "recent" ? "is-active" : ""}`}
                onClick={() => handleSelectSessionFolder("recent")}
              >
                <span>Recent</span>
                <span>{recentSessions.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sessionFolder === "archived"}
                className={`workstation-session-view-button ${sessionFolder === "archived" ? "is-active" : ""}`}
                onClick={() => handleSelectSessionFolder("archived")}
              >
                <span>Archived</span>
                <span>{archivedSessions.length}</span>
              </button>
            </div>
          </div>
          <div className="workstation-thread-list">
            {visibleSessions.length > 0 ? (
              visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className={`workstation-thread ${activeSessionId === session.id ? "is-active" : ""}`}
                >
                  <div className="workstation-thread-header">
                    <button
                      type="button"
                      onClick={() => onOpenSession(session.id)}
                      className="workstation-thread-open"
                    >
                      <div className="workstation-thread-meta">
                        <span className={`session-status session-status-${session.status}`}>
                          {STATUS_LABELS[session.status]}
                        </span>
                        <span>{formatRelativeTime(session.updatedAt)}</span>
                      </div>
                      <div className="workstation-thread-title">{session.title}</div>
                      <div className="workstation-thread-preview">
                        {session.preview || "No messages saved yet."}
                      </div>
                      <div className="workstation-thread-foot">
                        <span>{session.currentTurn} turns</span>
                        <span>{session.messageCount} messages</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="workstation-thread-action"
                      aria-label={`Manage ${session.title}`}
                      title={session.archivedAt == null ? "Archive or delete session" : "Restore or delete session"}
                      onClick={() => setPendingSessionAction(session)}
                    >
                      <MoreIcon size={14} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="workstation-empty-state">
                {sessionFolder === "recent"
                  ? "Your active council sessions will appear here after the first run."
                  : "Archived sessions stay here until you restore them."}
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="workstation-main">
        <div className="workstation-toolbar">
          <div className="workstation-toolbar-copy">
            <span className="workstation-kicker">Session Workstation</span>
            <h1 className="workstation-home-title">Start a new session or pick up a saved one.</h1>
          </div>
          <div className="workstation-toolbar-badges">
            <div className="workstation-metric">
              <span className="workstation-metric-label">Providers ready</span>
              <span className="workstation-metric-value">
                {configuredProviders.length}/{AGENT_CARDS.length}
              </span>
            </div>
            <div className="workstation-metric">
              <span className="workstation-metric-label">Autosave</span>
              <span className="workstation-metric-value">Local-first</span>
            </div>
          </div>
        </div>

        <div className="workstation-stage">
          <section className="workstation-composer-card">
            <div className="workstation-composer-header">
              <div className="workstation-hero">
                <div className="workstation-hero-mark">
                  <CouncilMark size={84} />
                </div>
                <div>
                  <div className="workstation-hero-kicker">Council Chamber</div>
                  <h2 className="elegant-title workstation-display-title">Let the council work.</h2>
                  <p className="workstation-subtitle">
                    Every thread is autosaved locally, resumable, and indexed like a real workstation.
                  </p>
                </div>
              </div>
            </div>

            <div className="workstation-composer-body">
              <label htmlFor="topic-input" className="workstation-input-label">
                Start a new line of inquiry
              </label>
              <div className="workstation-input-shell">
                <input
                  id="topic-input"
                  type="text"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleStart();
                    }
                  }}
                  placeholder="What should the council pressure-test next?"
                  className="elegant-input workstation-input"
                />
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!topic.trim()}
                  className="workstation-launch-button"
                >
                  <span>Open Session</span>
                  <ArrowIcon size={18} />
                </button>
              </div>

              <div className="workstation-suggestion-row">
                {sampleTopics.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setTopic(sample)}
                    className="workstation-suggestion-chip"
                  >
                    {sample}
                  </button>
                ))}
              </div>

              {showApiWarning && !hasAnyApiKey() && (
                <div className="workstation-warning">
                  <AlertIcon size={18} />
                  <div>
                    Configure at least one provider before opening a new council session.
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSettings(true)}
                    className="workstation-inline-link"
                  >
                    Open settings
                  </button>
                </div>
              )}
            </div>
          </section>

          <aside className="workstation-inspector">
            <div className="workstation-panel">
              <div className="workstation-panel-heading">Council Rack</div>
              <div className="workstation-agent-grid">
                {AGENT_CARDS.map((agent) => {
                  const configured = configuredProviders.includes(agent.provider);
                  return (
                    <div key={agent.provider} className={`workstation-agent-card ${configured ? "is-ready" : ""}`}>
                      <ProviderIcon provider={agent.provider} size={28} />
                      <div>
                        <div className="workstation-agent-name" style={{ color: agent.color }}>
                          {agent.name}
                        </div>
                        <div className="workstation-agent-provider">
                          {PROVIDER_INFO[agent.provider].name}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      </main>

      <ConfigModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        config={config}
        onUpdateCredential={updateCredential}
        onUpdateProxy={updateProxy}
        onUpdatePreferences={updatePreferences}
        onUpdateModel={updateModel}
      />

      {pendingSessionAction && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPendingSessionAction(null);
            }
          }}
        >
          <div className="modal-content session-action-modal">
            <div className="session-action-eyebrow">
              {isArchivedActionTarget ? "Archived Session" : "Session Actions"}
            </div>
            <h2 className="session-action-title">{pendingSessionAction.title}</h2>
            <p className="session-action-copy">
              {isArchivedActionTarget
                ? "Restore returns this session to Recent. Delete removes it permanently from local storage."
                : "Archive keeps this session saved but removes it from Recent. Delete removes it permanently from local storage."}
            </p>
            <div className="session-action-buttons">
              <button
                type="button"
                className="session-action-button is-neutral"
                onClick={() => setPendingSessionAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="session-action-button is-archive"
                onClick={() => {
                  if (isArchivedActionTarget) {
                    onRestoreSession(pendingSessionAction.id);
                  } else {
                    onArchiveSession(pendingSessionAction.id);
                  }
                  setPendingSessionAction(null);
                }}
              >
                {isArchivedActionTarget ? <RestoreIcon size={15} /> : <ArchiveIcon size={15} />}
                <span>{isArchivedActionTarget ? "Restore" : "Archive"}</span>
              </button>
              <button
                type="button"
                className="session-action-button is-delete"
                onClick={() => {
                  onDeleteSession(pendingSessionAction.id);
                  setPendingSessionAction(null);
                }}
              >
                <TrashIcon size={15} />
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showArchivedEmptyNotice && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowArchivedEmptyNotice(false);
            }
          }}
        >
          <div className="modal-content session-action-modal session-empty-modal">
            <div className="session-action-eyebrow">Archive</div>
            <h2 className="session-action-title">No archived sessions yet</h2>
            <p className="session-action-copy">
              Archive a recent session to move it out of Recent without deleting it. Archived sessions
              will appear here when they exist.
            </p>
            <div className="session-action-buttons is-single">
              <button
                type="button"
                className="session-action-button is-neutral"
                onClick={() => setShowArchivedEmptyNotice(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
