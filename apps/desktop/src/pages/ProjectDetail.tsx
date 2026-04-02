import { useState } from "react";

import type { Page } from "../App";
import type { ComposerAttachment } from "../services/attachments";
import type { SessionSummary, SessionStatus } from "../services/sessions";
import {
  saveProject,
  removeDossierEntry,
  type Project,
} from "../services/projects";

interface ProjectDetailProps {
  project: Project;
  sessions: SessionSummary[];
  onNavigate: (page: Page, sessionId?: string) => void;
  onOpenSession: (sessionId: string) => void;
  onCreateSession: (topic: string, attachments: ComposerAttachment[], projectId?: string | null) => void | Promise<void>;
  onUpdateProject: (project: Project) => void;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  completed: "Complete",
};

function formatRelativeTime(timestamp: number): string {
  const absMs = Math.abs(timestamp - Date.now());
  const minutes = Math.round(absMs / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectDetail({
  project,
  sessions,
  onNavigate,
  onOpenSession,
  onCreateSession,
  onUpdateProject,
}: ProjectDetailProps) {
  const [newTopic, setNewTopic] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const [editDescription, setEditDescription] = useState(project.description);
  const [activeTab, setActiveTab] = useState<"sessions" | "dossier">("sessions");

  const recentSessions = sessions.filter((s) => s.archivedAt == null);
  const archivedSessions = sessions.filter((s) => s.archivedAt != null);

  const handleSaveEdit = () => {
    if (!editName.trim()) return;
    const updated = saveProject({
      ...project,
      name: editName.trim(),
      description: editDescription.trim(),
      updatedAt: Date.now(),
    });
    onUpdateProject(updated);
    setIsEditing(false);
  };

  const handleCreateSession = () => {
    if (!newTopic.trim()) return;
    void onCreateSession(newTopic.trim(), [], project.id);
    setNewTopic("");
  };

  const handleRemoveDossierEntry = (attachmentId: string) => {
    const updated = removeDossierEntry(project.id, attachmentId);
    if (updated) {
      onUpdateProject(updated);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100">
      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "14px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => onNavigate("home")}
            style={{
              background: "none",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "rgba(255,255,255,0.6)",
              padding: "4px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Back
          </button>
          <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>
            Projects / {project.name}
          </span>
        </div>

        {isEditing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={120}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "#fff",
                padding: "6px 10px",
                fontSize: 18,
                fontWeight: 600,
              }}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveEdit();
                if (e.key === "Escape") setIsEditing(false);
              }}
            />
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Description (optional)"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "#fff",
                padding: "6px 10px",
                fontSize: 13,
                minHeight: 48,
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.6)",
                  padding: "4px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={!editName.trim()}
                style={{
                  background: "rgba(99,102,241,0.2)",
                  border: "1px solid rgba(99,102,241,0.3)",
                  borderRadius: 6,
                  color: "#a5b4fc",
                  padding: "4px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{project.name}</h1>
              <button
                type="button"
                onClick={() => {
                  setEditName(project.name);
                  setEditDescription(project.description);
                  setIsEditing(true);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(255,255,255,0.35)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Edit
              </button>
            </div>
            {project.description && (
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginTop: 4 }}>
                {project.description}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "0 20px" }}>
        <button
          type="button"
          onClick={() => setActiveTab("sessions")}
          style={{
            background: "none",
            border: "none",
            borderBottom: activeTab === "sessions" ? "2px solid #a5b4fc" : "2px solid transparent",
            color: activeTab === "sessions" ? "#fff" : "rgba(255,255,255,0.5)",
            padding: "10px 16px",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Sessions ({sessions.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("dossier")}
          style={{
            background: "none",
            border: "none",
            borderBottom: activeTab === "dossier" ? "2px solid #a5b4fc" : "2px solid transparent",
            color: activeTab === "dossier" ? "#fff" : "rgba(255,255,255,0.5)",
            padding: "10px 16px",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Dossier ({project.dossier.length})
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {activeTab === "sessions" && (
          <div>
            {/* New session input */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                type="text"
                placeholder="Start a new session in this project..."
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateSession();
                }}
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  color: "#fff",
                  padding: "8px 14px",
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                disabled={!newTopic.trim()}
                onClick={handleCreateSession}
                style={{
                  background: "rgba(99,102,241,0.2)",
                  border: "1px solid rgba(99,102,241,0.3)",
                  borderRadius: 8,
                  color: "#a5b4fc",
                  padding: "8px 16px",
                  fontSize: 13,
                  cursor: newTopic.trim() ? "pointer" : "default",
                  opacity: newTopic.trim() ? 1 : 0.4,
                }}
              >
                New Session
              </button>
            </div>

            {/* Session list */}
            {recentSessions.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                  Active ({recentSessions.length})
                </div>
                {recentSessions.map((session) => (
                  <div
                    key={session.id}
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8,
                      padding: "10px 14px",
                      marginBottom: 6,
                      cursor: "pointer",
                    }}
                    onClick={() => onOpenSession(session.id)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span className={`session-status session-status-${session.status}`} style={{ fontSize: 11 }}>
                        {STATUS_LABELS[session.status]}
                      </span>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{session.title}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                      {session.currentTurn} turns &middot; {session.messageCount} messages
                    </div>
                  </div>
                ))}
              </div>
            )}

            {archivedSessions.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                  Archived ({archivedSessions.length})
                </div>
                {archivedSessions.map((session) => (
                  <div
                    key={session.id}
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 8,
                      padding: "10px 14px",
                      marginBottom: 6,
                      cursor: "pointer",
                      opacity: 0.6,
                    }}
                    onClick={() => onOpenSession(session.id)}
                  >
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{session.title}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                      {session.currentTurn} turns &middot; Archived
                    </div>
                  </div>
                ))}
              </div>
            )}

            {sessions.length === 0 && (
              <div style={{ textAlign: "center", color: "rgba(255,255,255,0.35)", padding: "40px 0", fontSize: 14 }}>
                No sessions yet. Start a new session above.
              </div>
            )}
          </div>
        )}

        {activeTab === "dossier" && (
          <div>
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginBottom: 16 }}>
              Evidence accumulated across sessions in this project. Promote attachments from sessions
              or upload directly to build a durable research dossier.
            </p>

            {project.dossier.length > 0 ? (
              project.dossier.map((entry) => (
                <div
                  key={entry.attachmentId}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    padding: "10px 14px",
                    marginBottom: 6,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{entry.name}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                      {entry.kind.toUpperCase()} &middot; {formatBytes(entry.size)} &middot; Added {formatRelativeTime(entry.addedAt)}
                    </div>
                    {entry.note && (
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 4, fontStyle: "italic" }}>
                        {entry.note}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveDossierEntry(entry.attachmentId)}
                    style={{
                      background: "none",
                      border: "1px solid rgba(239,68,68,0.2)",
                      borderRadius: 6,
                      color: "rgba(239,68,68,0.7)",
                      padding: "4px 8px",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))
            ) : (
              <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", padding: "40px 0", fontSize: 14 }}>
                No evidence yet. Promote attachments from completed sessions to build the dossier.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
