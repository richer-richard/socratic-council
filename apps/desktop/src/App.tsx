import { useState, useCallback } from "react";
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
  const [sessions, setSessions] = useState(() => stabilizeStoredSessions());
  const [projects, setProjects] = useState(() => listProjectSummaries());
  const [activeSession, setActiveSession] = useState<DiscussionSession | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [appError, setAppError] = useState<string | null>(null);

  const refreshAll = useCallback(() => {
    setSessions(listSessionSummaries());
    setProjects(listProjectSummaries());
  }, []);

  const navigate = useCallback((page: Page, sessionId?: string) => {
    if (page === "chat") {
      const targetSessionId = sessionId ?? state.currentSessionId;
      if (!targetSessionId) return;

      const nextSession = touchDiscussionSession(targetSessionId) ?? loadDiscussionSession(targetSessionId);
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
  }, [state.currentSessionId, refreshAll]);

  const handleCreateSession = useCallback(async (
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
  }, [refreshAll]);

  const handleOpenSession = useCallback((sessionId: string) => {
    const session = touchDiscussionSession(sessionId) ?? loadDiscussionSession(sessionId);
    if (!session) return;

    setActiveSession(session);
    refreshAll();
    setState((prev) => ({
      currentPage: "chat",
      currentSessionId: session.id,
      currentProjectId: session.projectId ?? prev.currentProjectId,
    }));
  }, [refreshAll]);

  const handlePersistSession = useCallback((session: DiscussionSession) => {
    const persisted = saveDiscussionSession(session);
    setAppError(null);
    refreshAll();
    return persisted;
  }, [refreshAll]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
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
  }, [refreshAll]);

  const handleArchiveSession = useCallback((sessionId: string) => {
    const archived = archiveDiscussionSession(sessionId);
    if (!archived) return;

    refreshAll();
    setActiveSession((current) => (current?.id === sessionId ? null : current));
    setState((current) => ({
      ...current,
      currentSessionId: current.currentSessionId === sessionId ? null : current.currentSessionId,
    }));
  }, [refreshAll]);

  const handleRestoreSession = useCallback((sessionId: string) => {
    const restored = restoreDiscussionSession(sessionId);
    if (!restored) return;

    refreshAll();
  }, [refreshAll]);

  const handleCreateProject = useCallback((name: string, description?: string) => {
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
  }, [refreshAll]);

  const handleOpenProject = useCallback((projectId: string) => {
    const project = touchProject(projectId) ?? loadProject(projectId);
    if (!project) return;

    setActiveProject(project);
    refreshAll();
    setState((prev) => ({
      ...prev,
      currentPage: "project",
      currentProjectId: project.id,
    }));
  }, [refreshAll]);

  const handleDeleteProject = useCallback((projectId: string) => {
    const deleted = deleteProject(projectId);
    if (!deleted) return;

    refreshAll();
    setActiveProject((current) => (current?.id === projectId ? null : current));
    setState((current) => ({
      ...current,
      currentPage: current.currentPage === "project" && current.currentProjectId === projectId ? "home" : current.currentPage,
      currentProjectId: current.currentProjectId === projectId ? null : current.currentProjectId,
    }));
  }, [refreshAll]);

  const handleArchiveProject = useCallback((projectId: string) => {
    const archived = archiveProject(projectId);
    if (!archived) return;

    refreshAll();
    setActiveProject((current) => (current?.id === projectId ? null : current));
  }, [refreshAll]);

  const handleRestoreProject = useCallback((projectId: string) => {
    const restored = restoreProject(projectId);
    if (!restored) return;

    refreshAll();
  }, [refreshAll]);

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {appError ? (
        <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {appError}
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
        />
      )}
      {state.currentPage === "settings" && <Settings onNavigate={navigate} />}
      {state.currentPage === "chat" && activeSession && (
        <Chat
          key={activeSession.id}
          session={activeSession}
          onNavigate={navigate}
          onPersistSession={handlePersistSession}
        />
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
  );
}
