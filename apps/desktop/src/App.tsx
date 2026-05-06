import { useState, useCallback, useEffect } from "react";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Chat } from "./pages/Chat";
import { ProjectDetail } from "./pages/ProjectDetail";
import type { ComposerAttachment } from "./services/attachments";
import {
  archiveDiscussionSession,
  createDiscussionSession,
  deleteDiscussionSessionWithAttachments,
  listSessionSummaries,
  loadDiscussionSession,
  restoreDiscussionSession,
  saveDiscussionSession,
  stabilizeStoredSessions,
  touchDiscussionSession,
  type DiscussionSession,
} from "./services/sessions";
import {
  archiveProject,
  createProject,
  deleteProject,
  listProjectSummaries,
  loadProject,
  refreshProjectSummary,
  restoreProject,
  touchProject,
  type Project,
} from "./services/projects";
import {
  getDecryptFailureCount,
  getQuarantinePath,
  getVaultStatus,
  initVault,
} from "./services/vault";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AmbientStars } from "./components/AmbientStars";
import { CommandPalette, useCommandPaletteShortcut } from "./components/CommandPalette";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { registerCommand, resetCommandsForTests } from "./utils/commandPalette";
import { useConfig } from "./stores/config";

export type Page = "home" | "settings" | "chat" | "project";

export interface AppState {
  currentPage: Page;
  currentSessionId: string | null;
  currentProjectId: string | null;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    currentPage: "home",
    currentSessionId: null,
    currentProjectId: null,
  });
  // Sessions and projects load after the vault init completes so encrypted
  // records stored in localStorage can be decrypted. The brief pre-load window
  // shows an empty sidebar — acceptable for a desktop app startup.
  const [sessions, setSessions] = useState<ReturnType<typeof listSessionSummaries>>([]);
  const [projects, setProjects] = useState<ReturnType<typeof listProjectSummaries>>([]);

  // Global ⌘K command palette — binding lives here so it works on any page.
  const palette = useCommandPaletteShortcut();

  const [showDiagnostics, setShowDiagnostics] = useState(false);
  /**
   * Boot-time warning when the vault DEK file was quarantined and there's
   * pre-existing encrypted data on disk that probably can't be decrypted
   * with the new DEK (fix 1.1). Null when the vault is healthy.
   */
  const [vaultRecoveryNotice, setVaultRecoveryNotice] = useState<{
    quarantinePath: string | null;
    failedDecrypts: number;
  } | null>(null);
  /**
   * Set when `initVault()` finishes with status === "init_failed" — the DEK
   * file couldn't be read or written at all (e.g. a permissions issue under
   * `~/Library/Application Support/...`). When this is true we render a
   * hard-stop screen instead of letting the app fall back to plaintext
   * writes against localStorage. The user can dismiss the screen via
   * "Continue without encryption", which sets `encryptionBypassAcked` for
   * this session only (sessionStorage, not localStorage — so the next boot
   * re-asks).
   */
  const [vaultInitFailed, setVaultInitFailed] = useState(false);
  const [encryptionBypassAcked, setEncryptionBypassAcked] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("socratic-council-encryption-bypass-acked") === "1";
    } catch {
      return false;
    }
  });
  const { config, getMaxTurns: getMaxTurnsLive } = useConfig();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initVault();
      } catch (error) {
        console.error("[App] initVault failed:", error);
      }
      if (cancelled) return;

      // Surface a boot-time banner when the DEK was quarantined and there's
      // pre-existing encrypted data on disk that the new DEK can't decrypt
      // (fix 1.1). We trigger stabilizeStoredSessions BEFORE the check so
      // any decrypt failures from the load loop count toward the tally.
      const sessionSummaries = stabilizeStoredSessions();
      setSessions(sessionSummaries);
      setProjects(listProjectSummaries());

      const status = getVaultStatus();
      const failedDecrypts = getDecryptFailureCount();
      if (status === "init_failed") {
        setVaultInitFailed(true);
      }
      if (status === "quarantined" || failedDecrypts > 0) {
        setVaultRecoveryNotice({
          quarantinePath: getQuarantinePath(),
          failedDecrypts,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Register a baseline command set — other pages can register additional
  // commands as they mount, and `resetCommandsForTests` guards test-only
  // environments from stale registrations.
  useEffect(() => {
    resetCommandsForTests();
    const unregisters = [
      registerCommand({
        id: "nav.home",
        label: "Go to home",
        category: "Navigate",
        keywords: ["home", "workstation", "back"],
        run: () => setState((p) => ({ ...p, currentPage: "home" })),
      }),
      registerCommand({
        id: "nav.settings",
        label: "Open settings",
        category: "Navigate",
        keywords: ["config", "api keys", "preferences"],
        shortcut: "⌘,",
        run: () => setState((p) => ({ ...p, currentPage: "settings" })),
      }),
      registerCommand({
        id: "diagnostics.open",
        label: "Open diagnostics",
        category: "Support",
        keywords: ["logs", "health", "debug", "copy diagnostics"],
        run: () => setShowDiagnostics(true),
      }),
    ];
    return () => {
      for (const dispose of unregisters) dispose();
    };
  }, []);
  const [activeSession, setActiveSession] = useState<DiscussionSession | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [appError, setAppError] = useState<string | null>(null);

  const refreshAll = useCallback(() => {
    setSessions(listSessionSummaries());
    setProjects(listProjectSummaries());
  }, []);

  const navigate = useCallback(
    (page: Page, sessionId?: string) => {
      if (page === "chat") {
        const targetSessionId = sessionId ?? state.currentSessionId;
        if (!targetSessionId) return;

        const nextSession =
          touchDiscussionSession(targetSessionId) ?? loadDiscussionSession(targetSessionId);
        if (!nextSession) return;

        setActiveSession(nextSession);
        refreshAll();
        setState((prev) => ({
          currentPage: "chat",
          currentSessionId: nextSession.id,
          currentProjectId: nextSession.projectId ?? prev.currentProjectId,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        currentPage: page,
        currentSessionId: sessionId ?? prev.currentSessionId,
      }));
    },
    [state.currentSessionId, refreshAll],
  );

  const handleCreateSession = useCallback(
    async (
      topic: string,
      attachments: ComposerAttachment[] = [],
      projectId: string | null = null,
    ) => {
      try {
        const liveCap = getMaxTurnsLive();
        const capSnapshot = liveCap === Infinity ? null : liveCap;
        const session = await createDiscussionSession(topic, attachments, projectId, capSnapshot);
        setAppError(null);
        setActiveSession(session);
        if (projectId) {
          refreshProjectSummary(projectId);
        }
        refreshAll();
        setState((prev) => ({
          currentPage: "chat",
          currentSessionId: session.id,
          currentProjectId: projectId ?? prev.currentProjectId,
        }));
      } catch (error) {
        console.error("Failed to create session:", error);
        setAppError(
          error instanceof Error
            ? error.message
            : "Failed to create the session locally. Free up browser storage and try again.",
        );
      }
    },
    [refreshAll, getMaxTurnsLive],
  );

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      const session = touchDiscussionSession(sessionId) ?? loadDiscussionSession(sessionId);
      if (!session) return;

      setActiveSession(session);
      refreshAll();
      setState((prev) => ({
        currentPage: "chat",
        currentSessionId: session.id,
        currentProjectId: session.projectId ?? prev.currentProjectId,
      }));
    },
    [refreshAll],
  );

  const handlePersistSession = useCallback(
    (session: DiscussionSession) => {
      const persisted = saveDiscussionSession(session);
      setAppError(null);
      refreshAll();
      return persisted;
    },
    [refreshAll],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const deleted = await deleteDiscussionSessionWithAttachments(sessionId);
      if (!deleted) return;

      refreshAll();
      setActiveSession((current) => (current?.id === sessionId ? null : current));
      setState((current) => {
        if (current.currentSessionId !== sessionId) {
          return current;
        }

        return {
          ...current,
          currentPage: current.currentPage === "chat" ? "home" : current.currentPage,
          currentSessionId: null,
        };
      });
    },
    [refreshAll],
  );

  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      const archived = archiveDiscussionSession(sessionId);
      if (!archived) return;

      refreshAll();
      setActiveSession((current) => (current?.id === sessionId ? null : current));
      setState((current) => ({
        ...current,
        currentSessionId: current.currentSessionId === sessionId ? null : current.currentSessionId,
      }));
    },
    [refreshAll],
  );

  const handleRestoreSession = useCallback(
    (sessionId: string) => {
      const restored = restoreDiscussionSession(sessionId);
      if (!restored) return;

      refreshAll();
    },
    [refreshAll],
  );

  const handleCreateProject = useCallback(
    (name: string, description?: string) => {
      try {
        const project = createProject(name, description);
        setAppError(null);
        setActiveProject(project);
        refreshAll();
        setState((prev) => ({
          ...prev,
          currentPage: "project",
          currentProjectId: project.id,
        }));
      } catch (error) {
        console.error("Failed to create project:", error);
        setAppError(
          error instanceof Error
            ? error.message
            : "Failed to create the project locally. Free up browser storage and try again.",
        );
      }
    },
    [refreshAll],
  );

  const handleOpenProject = useCallback(
    (projectId: string) => {
      const project = touchProject(projectId) ?? loadProject(projectId);
      if (!project) return;

      setActiveProject(project);
      refreshAll();
      setState((prev) => ({
        ...prev,
        currentPage: "project",
        currentProjectId: project.id,
      }));
    },
    [refreshAll],
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      const deleted = deleteProject(projectId);
      if (!deleted) return;

      refreshAll();
      setActiveProject((current) => (current?.id === projectId ? null : current));
      setState((current) => ({
        ...current,
        currentPage:
          current.currentPage === "project" && current.currentProjectId === projectId
            ? "home"
            : current.currentPage,
        currentProjectId: current.currentProjectId === projectId ? null : current.currentProjectId,
      }));
    },
    [refreshAll],
  );

  const handleArchiveProject = useCallback(
    (projectId: string) => {
      const archived = archiveProject(projectId);
      if (!archived) return;

      refreshAll();
      setActiveProject((current) => (current?.id === projectId ? null : current));
    },
    [refreshAll],
  );

  const handleRestoreProject = useCallback(
    (projectId: string) => {
      const restored = restoreProject(projectId);
      if (!restored) return;

      refreshAll();
    },
    [refreshAll],
  );

  if (vaultInitFailed && !encryptionBypassAcked) {
    return (
      <ErrorBoundary label="app">
        <div className="h-screen flex items-center justify-center bg-gray-900 text-gray-100 p-6">
          <div
            className="max-w-lg w-full rounded-2xl border border-red-500/30 bg-red-500/5 p-6"
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <h2 className="text-lg font-semibold text-red-300">Encryption is unavailable</h2>
            <p className="text-sm text-gray-300 leading-relaxed">
              The encryption key file couldn't be initialized on this machine. Sessions and API keys
              can't be safely stored right now. This usually means filesystem permissions on{" "}
              <code className="text-gray-200">
                ~/Library/Application Support/com.socratic-council.desktop/
              </code>{" "}
              are blocking the app from writing the key file.
            </p>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-sm font-medium transition-colors"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    sessionStorage.setItem("socratic-council-encryption-bypass-acked", "1");
                  } catch {
                    /* sessionStorage unavailable; bypass stays in-memory only */
                  }
                  setEncryptionBypassAcked(true);
                }}
                className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                Continue without encryption
              </button>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Continuing without encryption stores keys and sessions in plain text on disk for this
              session only. The setting resets when you relaunch the app.
            </p>
          </div>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary label="app">
      <div className="h-screen flex flex-col bg-gray-900">
        <AmbientStars />
        {appError ? (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {appError}
          </div>
        ) : null}
        {vaultRecoveryNotice ? (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 flex items-start gap-3">
            <div style={{ flex: 1 }}>
              <strong>Encrypted data may be unrecoverable.</strong> The vault DEK file was
              unreadable on this boot
              {vaultRecoveryNotice.quarantinePath ? (
                <>
                  {" "}
                  and was quarantined to{" "}
                  <code style={{ wordBreak: "break-all" }}>
                    {vaultRecoveryNotice.quarantinePath}
                  </code>
                </>
              ) : null}
              . A fresh key was generated.{" "}
              {vaultRecoveryNotice.failedDecrypts > 0 ? (
                <>
                  {vaultRecoveryNotice.failedDecrypts} encrypted entr
                  {vaultRecoveryNotice.failedDecrypts === 1 ? "y" : "ies"} failed to decrypt during
                  startup.
                </>
              ) : null}{" "}
              If you have a backup of the original <code>vault.key</code> file, restoring it should
              recover your data.
            </div>
            <button
              type="button"
              onClick={() => setVaultRecoveryNotice(null)}
              className="text-amber-200 hover:text-amber-50"
              style={{ background: "none", border: "none", cursor: "pointer" }}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {state.currentPage === "home" && (
          <Home
            sessions={sessions}
            projects={projects}
            activeSessionId={state.currentSessionId}
            onArchiveSession={handleArchiveSession}
            onCreateSession={handleCreateSession}
            onDeleteSession={handleDeleteSession}
            onOpenSession={handleOpenSession}
            onRestoreSession={handleRestoreSession}
            onCreateProject={handleCreateProject}
            onOpenProject={handleOpenProject}
            onDeleteProject={handleDeleteProject}
            onArchiveProject={handleArchiveProject}
            onRestoreProject={handleRestoreProject}
            onBundleImported={(sessionId) => {
              refreshAll();
              handleOpenSession(sessionId);
            }}
          />
        )}
        {state.currentPage === "settings" && <Settings onNavigate={navigate} />}
        {state.currentPage === "chat" && activeSession && (
          <ErrorBoundary label="chat">
            <Chat
              key={activeSession.id}
              session={activeSession}
              onNavigate={navigate}
              onPersistSession={handlePersistSession}
            />
          </ErrorBoundary>
        )}
        {state.currentPage === "project" && activeProject && (
          <ProjectDetail
            project={activeProject}
            sessions={sessions.filter((s) => s.projectId === activeProject.id)}
            onNavigate={navigate}
            onOpenSession={handleOpenSession}
            onCreateSession={handleCreateSession}
            onUpdateProject={(updated) => {
              setActiveProject(updated);
              refreshAll();
            }}
          />
        )}
      </div>

      {/* Global additive surfaces — overlay the page, don't modify its layout. */}
      <CommandPalette open={palette.open} onClose={palette.close} />
      <DiagnosticsPanel
        open={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        config={config}
      />
    </ErrorBoundary>
  );
}
