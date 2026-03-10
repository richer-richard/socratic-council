import { useState, useCallback } from "react";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Chat } from "./pages/Chat";
import {
  archiveDiscussionSession,
  createDiscussionSession,
  deleteDiscussionSession,
  listSessionSummaries,
  loadDiscussionSession,
  restoreDiscussionSession,
  saveDiscussionSession,
  stabilizeStoredSessions,
  touchDiscussionSession,
  type DiscussionSession,
} from "./services/sessions";

export type Page = "home" | "settings" | "chat";

export interface AppState {
  currentPage: Page;
  currentSessionId: string | null;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    currentPage: "home",
    currentSessionId: null,
  });
  const [sessions, setSessions] = useState(() => stabilizeStoredSessions());
  const [activeSession, setActiveSession] = useState<DiscussionSession | null>(null);

  const navigate = useCallback((page: Page, sessionId?: string) => {
    if (page === "chat") {
      const targetSessionId = sessionId ?? state.currentSessionId;
      if (!targetSessionId) return;

      const nextSession = touchDiscussionSession(targetSessionId) ?? loadDiscussionSession(targetSessionId);
      if (!nextSession) return;

      setActiveSession(nextSession);
      setSessions(listSessionSummaries());
      setState({
        currentPage: "chat",
        currentSessionId: nextSession.id,
      });
      return;
    }

    setState((prev) => ({
      currentPage: page,
      currentSessionId: sessionId ?? prev.currentSessionId,
    }));
  }, [state.currentSessionId]);

  const handleCreateSession = useCallback((topic: string) => {
    const session = createDiscussionSession(topic);
    setActiveSession(session);
    setSessions(listSessionSummaries());
    setState({
      currentPage: "chat",
      currentSessionId: session.id,
    });
  }, []);

  const handleOpenSession = useCallback((sessionId: string) => {
    const session = touchDiscussionSession(sessionId) ?? loadDiscussionSession(sessionId);
    if (!session) return;

    setActiveSession(session);
    setSessions(listSessionSummaries());
    setState({
      currentPage: "chat",
      currentSessionId: session.id,
    });
  }, []);

  const handlePersistSession = useCallback((session: DiscussionSession) => {
    saveDiscussionSession(session);
    setSessions(listSessionSummaries());
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    const deleted = deleteDiscussionSession(sessionId);
    if (!deleted) return;

    setSessions(listSessionSummaries());
    setActiveSession((current) => (current?.id === sessionId ? null : current));
    setState((current) => {
      if (current.currentSessionId !== sessionId) {
        return current;
      }

      return {
        currentPage: current.currentPage === "chat" ? "home" : current.currentPage,
        currentSessionId: null,
      };
    });
  }, []);

  const handleArchiveSession = useCallback((sessionId: string) => {
    const archived = archiveDiscussionSession(sessionId);
    if (!archived) return;

    setSessions(listSessionSummaries());
    setActiveSession((current) => (current?.id === sessionId ? null : current));
    setState((current) => ({
      ...current,
      currentSessionId: current.currentSessionId === sessionId ? null : current.currentSessionId,
    }));
  }, []);

  const handleRestoreSession = useCallback((sessionId: string) => {
    const restored = restoreDiscussionSession(sessionId);
    if (!restored) return;

    setSessions(listSessionSummaries());
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {state.currentPage === "home" && (
        <Home
          sessions={sessions}
          activeSessionId={state.currentSessionId}
          onArchiveSession={handleArchiveSession}
          onCreateSession={handleCreateSession}
          onDeleteSession={handleDeleteSession}
          onOpenSession={handleOpenSession}
          onRestoreSession={handleRestoreSession}
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
    </div>
  );
}
