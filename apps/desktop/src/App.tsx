import { useState, useCallback, useEffect } from "react";

import { AmbientStars } from "./components/AmbientStars";
import { CommandPalette, useCommandPaletteShortcut } from "./components/CommandPalette";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Home } from "./pages/Home";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Session } from "./pages/Session";
import { Settings } from "./pages/Settings";
import { Transcript } from "./pages/Transcript";
import { loadSessionAttachmentDocuments, type ComposerAttachment } from "./services/attachments";
import {
  DEFAULT_LAUNCH,
  engineSettingsFromConfig,
  presetSeats,
  readProviderKeys,
  type SessionLaunchOptions,
} from "./services/engine";
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
import { secretsGet } from "./services/secrets";
import { initSessionBlobStore, registerSessionBlobHooks } from "./services/sessionBlobs";
import {
  archiveDiscussionSession,
  createDiscussionSession,
  deleteAllDiscussionSessions,
  deleteDiscussionSessionWithAttachments,
  listSessionSummaries,
  loadDiscussionSession,
  restoreDiscussionSession,
  stabilizeStoredSessions,
  touchDiscussionSession,
  type BulkDeleteResult,
  type DiscussionSession,
} from "./services/sessions";
import {
  deleteSharedSession,
  importEngineSession,
  importSharedSessions,
} from "./services/sessionSync";
import { describeSaveFailure } from "./services/storageErrors";
import {
  getDecryptFailureCount,
  getQuarantinePath,
  getVaultStatus,
  initVault,
} from "./services/vault";
import { reconveneNotes } from "./session/reconvene";
import type { SessionView } from "./session/reducer";
import {
  answerEngineQuestion,
  cancelEngineRun,
  decideEngineTool,
  forgetEngineRun,
  liveRunIds,
  startEngineRun,
  useEngineRun,
} from "./session/useEngineRuns";
import { PROVIDER_INFO, getStoreConfig, useConfig, type Provider } from "./stores/config";
import { registerCommand, resetCommandsForTests } from "./utils/commandPalette";

const ALL_PROVIDERS = Object.keys(PROVIDER_INFO) as Provider[];

function readProxyPassword(): string | undefined {
  try {
    return secretsGet("proxy:password") ?? undefined;
  } catch {
    return undefined;
  }
}

export type Page = "home" | "settings" | "chat" | "transcript" | "project";

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

      // Session blobs live in IndexedDB, not in the WebView's 5 MB
      // localStorage (services/sessionBlobs.ts). Hydrate that store — and
      // move any blob still in localStorage across — before anything reads
      // or writes a session.
      try {
        const blobs = await initSessionBlobStore();
        if (blobs.migrated > 0) {
          const pending =
            blobs.recovered > 0 ? ` (${blobs.recovered} of them a write that had not landed)` : "";
          console.info(
            `[App] moved ${blobs.migrated} session(s) out of localStorage into the session store${pending}`,
          );
        }
      } catch (error) {
        console.error("[App] session store init failed:", error);
      }
      if (cancelled) return;

      // Surface a boot-time banner when the DEK was quarantined and there's
      // pre-existing encrypted data on disk that the new DEK can't decrypt
      // (fix 1.1). We trigger stabilizeStoredSessions BEFORE the check so
      // any decrypt failures from the load loop count toward the tally.
      const sessionSummaries = stabilizeStoredSessions();
      setSessions(sessionSummaries);
      setProjects(listProjectSummaries());

      // Pull in anything the CLI wrote to the shared session store (and push
      // app-only sessions out so the terminal can see them). Best-effort.
      try {
        const synced = await importSharedSessions();
        if (!cancelled && (synced.imported > 0 || synced.exported > 0)) {
          setSessions(listSessionSummaries());
        }
      } catch (error) {
        console.warn("[App] session sync failed:", error);
      }

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

  // Re-sync with the shared session store whenever the window regains focus
  // (the user may have just finished a debate in the terminal). Throttled so
  // rapid focus flips don't hammer the disk.
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - last < 5000) return;
      last = now;
      void importSharedSessions().then((synced) => {
        if (synced.imported > 0 || synced.exported > 0) setSessions(listSessionSummaries());
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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
  const liveView = useEngineRun(state.currentSessionId);

  // A session blob reaches IndexedDB on a background queue, so a write that
  // fails there would otherwise be invisible: the app would show the session
  // as saved while nothing had been persisted. Surface it like any other
  // save failure.
  useEffect(() => {
    registerSessionBlobHooks({
      onPersistError: (_key, error) =>
        setAppError(describeSaveFailure("session", error, "sessions")),
    });
    return () => registerSessionBlobHooks({});
  }, []);

  const refreshAll = useCallback(() => {
    setSessions(listSessionSummaries());
    setProjects(listProjectSummaries());
  }, []);

  /**
   * When a run ends, the engine's session file (transcript, plan, board,
   * record, costs) becomes the stored session; the app-owned fields (project,
   * attachments, title) are kept. The live view is dropped once the stored
   * copy carries the same data.
   */
  const finishRun = useCallback(
    async (sessionId: string) => {
      const imported = await importEngineSession(sessionId);
      refreshAll();
      if (imported?.engine) {
        setActiveSession((current) => (current?.id === sessionId ? imported : current));
        forgetEngineRun(sessionId);
      }
    },
    [refreshAll],
  );

  /** Hand a freshly created session to the engine. */
  const launchEngine = useCallback(
    async (session: DiscussionSession, launch: SessionLaunchOptions) => {
      const settings = engineSettingsFromConfig(getStoreConfig(), readProxyPassword());
      const keys = readProviderKeys(ALL_PROVIDERS);
      const seats = presetSeats(settings.seats, keys, launch.preset);
      let attachments: { name: string; text: string }[] = [];
      try {
        const documents = await loadSessionAttachmentDocuments(session.attachments);
        attachments = documents
          .map((doc) => ({
            name: doc.attachment.name,
            text: doc.entries.map((entry) => entry.text).join("\n\n"),
          }))
          .filter((doc) => doc.text.trim().length > 0);
      } catch (error) {
        console.warn("[App] attachment text unavailable:", error);
      }
      try {
        await startEngineRun(
          {
            topic: session.topic,
            settings: { ...settings, seats },
            keys,
            attachments,
            forced: launch.deliverable === "auto" ? undefined : launch.deliverable,
            priorNotes: launch.priorNotes,
            sessionId: session.id,
          },
          { onFinished: (id) => void finishRun(id) },
        );
      } catch (error) {
        setAppError(error instanceof Error ? error.message : String(error));
      }
    },
    [finishRun],
  );

  /**
   * Open a stored session on `page`. Every route into a session goes through
   * here, so one that is listed but will not load reports it once, wherever it
   * was opened from.
   *
   * The index and the blobs can disagree: the blobs moved to IndexedDB, so a
   * build that predates that move reads localStorage, finds none, and lists
   * every session without being able to open any of them. Returning quietly
   * left the click doing nothing at all, with no way to tell that from a dead
   * button and no hint that nothing had been lost.
   */
  const openSessionOn = useCallback(
    (page: "chat" | "transcript", sessionId: string): boolean => {
      const session = touchDiscussionSession(sessionId) ?? loadDiscussionSession(sessionId);
      if (!session) {
        console.error("[App] session is in the index but did not load:", sessionId);
        setAppError(
          "That session is listed but its contents could not be read from the local store. " +
            "Nothing has been deleted.",
        );
        return false;
      }
      setAppError(null);
      setActiveSession(session);
      refreshAll();
      setState((prev) => ({
        currentPage: page,
        currentSessionId: session.id,
        currentProjectId: session.projectId ?? prev.currentProjectId,
      }));
      return true;
    },
    [refreshAll],
  );

  const navigate = useCallback(
    (page: Page, sessionId?: string) => {
      // Both session surfaces need the session loaded, so they take the same
      // path: the transcript is a second view of the same thing, not a
      // separate destination that could be reached without one.
      if (page === "chat" || page === "transcript") {
        const targetSessionId = sessionId ?? state.currentSessionId;
        if (!targetSessionId) return;
        openSessionOn(page, targetSessionId);
        return;
      }

      setState((prev) => ({
        ...prev,
        currentPage: page,
        currentSessionId: sessionId ?? prev.currentSessionId,
      }));
    },
    [state.currentSessionId, openSessionOn],
  );

  const handleCreateSession = useCallback(
    async (
      topic: string,
      attachments: ComposerAttachment[] = [],
      projectId: string | null = null,
      launch: SessionLaunchOptions = DEFAULT_LAUNCH,
    ) => {
      try {
        const session = await createDiscussionSession(topic, attachments, projectId, null);
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
        void launchEngine(session, launch);
      } catch (error) {
        console.error("Failed to create session:", error);
        setAppError(
          error instanceof Error ? error.message : "Failed to create the session locally.",
        );
      }
    },
    [refreshAll, launchEngine],
  );

  /**
   * Run a session's topic again as a new session, with its record (or its
   * last turns) as the planner's notes. The same as the terminal's reconvene.
   */
  const handleReconvene = useCallback(
    (session: DiscussionSession, view: SessionView | null) => {
      const priorNotes = reconveneNotes(view) ?? undefined;
      void handleCreateSession(session.topic, [], session.projectId ?? null, {
        ...DEFAULT_LAUNCH,
        priorNotes,
      });
    },
    [handleCreateSession],
  );

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      openSessionOn("chat", sessionId);
    },
    [openSessionOn],
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
          // The transcript points at the same session, so it has to fall back
          // too, or deleting the session leaves an empty page behind.
          currentPage:
            current.currentPage === "chat" || current.currentPage === "transcript"
              ? "home"
              : current.currentPage,
          currentSessionId: null,
        };
      });
    },
    [refreshAll],
  );

  // Every stored session except the ones still running. A live run would be
  // written straight back when the engine finishes, so it is kept and named in
  // the report instead of being deleted and quietly resurrected.
  const handleDeleteAllSessions = useCallback(async (): Promise<BulkDeleteResult> => {
    const live = new Set(liveRunIds());
    const result = await deleteAllDiscussionSessions({
      skip: live,
      deleteShared: deleteSharedSession,
    });
    refreshAll();
    setActiveSession((current) => (current && !live.has(current.id) ? null : current));
    setState((current) =>
      current.currentSessionId && !live.has(current.currentSessionId)
        ? {
            ...current,
            currentPage:
              current.currentPage === "chat" || current.currentPage === "transcript"
                ? "home"
                : current.currentPage,
            currentSessionId: null,
          }
        : current,
    );
    return result;
  }, [refreshAll]);

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
          error instanceof Error ? error.message : "Failed to create the project locally.",
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
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-3">
            {/* Dismissible, like the notice below it. When every session fails
                to open there is no successful open left to clear this, so
                without the button the strip eats a row of the frame for good. */}
            <div style={{ flex: 1 }}>{appError}</div>
            <button
              type="button"
              onClick={() => setAppError(null)}
              className="text-red-200 hover:text-red-50"
              style={{ background: "none", border: "none", cursor: "pointer" }}
            >
              Dismiss
            </button>
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
            onDeleteAllSessions={handleDeleteAllSessions}
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
          <ErrorBoundary label="session">
            <Session
              key={activeSession.id}
              session={activeSession}
              live={liveView}
              onNavigate={navigate}
              onCancel={(id) => void cancelEngineRun(id)}
              onAnswer={answerEngineQuestion}
              onDecide={decideEngineTool}
              onReconvene={handleReconvene}
            />
          </ErrorBoundary>
        )}
        {state.currentPage === "transcript" && activeSession && (
          <ErrorBoundary label="transcript">
            <Transcript
              key={`${activeSession.id}-transcript`}
              session={activeSession}
              live={liveView}
              onNavigate={navigate}
              onCancel={(id) => void cancelEngineRun(id)}
              onAnswer={answerEngineQuestion}
              onDecide={decideEngineTool}
              onReconvene={handleReconvene}
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
