import { useState, useCallback } from "react";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Chat } from "./pages/Chat";
import {
  createDiscussionSession,
  listSessionSummaries,
  loadDiscussionSession,
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

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {state.currentPage === "home" && (
        <Home
          sessions={sessions}
          activeSessionId={state.currentSessionId}
          onCreateSession={handleCreateSession}
          onOpenSession={handleOpenSession}
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
