import { useState } from "react";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Chat } from "./pages/Chat";

export type Page = "home" | "settings" | "chat";

export interface AppState {
  currentPage: Page;
  topic: string | null;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    currentPage: "home",
    topic: null,
  });

  const navigate = (page: Page, topic?: string) => {
    setState({
      currentPage: page,
      topic: topic ?? state.topic,
    });
  };

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {state.currentPage === "home" && <Home onNavigate={navigate} />}
      {state.currentPage === "settings" && <Settings onNavigate={navigate} />}
      {state.currentPage === "chat" && (
        <Chat topic={state.topic ?? ""} onNavigate={navigate} />
      )}
    </div>
  );
}
