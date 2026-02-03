import { useEffect } from "react";
import type { Page } from "../App";

interface SettingsProps {
  onNavigate: (page: Page) => void;
}

/**
 * Settings page - redirects to home with settings modal
 * The actual settings are now in the ConfigModal component
 */
export function Settings({ onNavigate }: SettingsProps) {
  useEffect(() => {
    // Redirect to home - settings are now in a modal
    onNavigate("home");
  }, [onNavigate]);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-gray-400">Redirecting to home...</div>
    </div>
  );
}
