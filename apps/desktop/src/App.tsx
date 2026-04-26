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
import { CommandPalette, useCommandPaletteShortcut } from "./components/CommandPalette";
import { TelemetryOptInCard } from "./components/TelemetryOptInCard";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { loadTelemetryConfig } from "./services/telemetry";
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

  // Telemetry first-launch card — shown once, then never again (acceptedAt
  // stays set either way). Suppressed on initial mount to avoid startup noise.
  const [showTelemetryCard, setShowTelemetryCard] = useState(false);
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
  const { config } = useConfig();

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
      if (status === "quarantined" || failedDecrypts > 0) {
        setVaultRecoveryNotice({
          quarantinePath: getQuarantinePath(),
          failedDecrypts,
        });
      }

      // First-launch telemetry prompt: only show if the user has never
      // recorded a choice AND has at least one session worth of activity.
      // Gated off until the maintainer deploys an ingest endpoint — the
      // services/telemetry.ts plumbing and the card component stay intact
      // so flipping this flag back to true is the only step required.
      const TELEMETRY_PROMPT_ENABLED = false;
      const telemetry = loadTelemetryConfig();
      if (
        TELEMETRY_PROMPT_ENABLED &&
        telemetry.acceptedAt == null &&
        listSessionSummaries().length > 0
      ) {
        setShowTelemetryCard(true);
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
        id: "privacy.reopen",
        label: "Reopen privacy / telemetry choice",
        category: "Privacy",
        keywords: ["telemetry", "analytics", "tracking"],
        run: () => setShowTelemetryCard(true),
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
        const session = await createDiscussionSession(topic, attachments, projectId);
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
    [refreshAll],
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

  return (
    <ErrorBoundary label="app">
      <div className="h-screen flex flex-col bg-gray-900">
        {appError ? (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {appError}
          </div>
        ) : null}
        {vaultRecoveryNotice ? (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 flex items-start gap-3">
            <div style={{ flex: 1 }}>
              <strong>Encrypted data may be unrecoverable.</strong>{" "}
              The vault DEK file was unreadable on this boot
              {vaultRecoveryNotice.quarantinePath ? (
                <>
                  {" "}and was quarantined to{" "}
                  <code style={{ wordBreak: "break-all" }}>
                    {vaultRecoveryNotice.quarantinePath}
                  </code>
                </>
              ) : null}
              . A fresh key was generated.{" "}
              {vaultRecoveryNotice.failedDecrypts > 0 ? (
                <>
                  {vaultRecoveryNotice.failedDecrypts} encrypted entr
                  {vaultRecoveryNotice.failedDecrypts === 1 ? "y" : "ies"} failed to decrypt
                  during startup.
                </>
              ) : null}{" "}
              If you have a backup of the original{" "}
              <code>vault.key</code> file, restoring it should recover your data.
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
      <TelemetryOptInCard
        open={showTelemetryCard}
        onClose={() => setShowTelemetryCard(false)}
      />
      <DiagnosticsPanel
        open={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        config={config}
      />
    </ErrorBoundary>
  );
}
