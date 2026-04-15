import { useEffect, useMemo, useRef, useState } from "react";

import { CouncilMark } from "../components/CouncilMark";
import { ConfigModal } from "../components/ConfigModal";
import { Starfield } from "../components/Starfield";
import { ProviderIcon } from "../components/icons/ProviderIcons";
import {
  buildAttachmentListLabel,
  createComposerAttachments,
  revokeComposerAttachmentPreviews,
  revokeComposerAttachmentPreview,
  type ComposerAttachment,
} from "../services/attachments";
import type { SessionSummary, SessionStatus } from "../services/sessions";
import type { ProjectSummary } from "../services/projects";
import { useConfig, getShuffledTopics, type Provider } from "../stores/config";

interface HomeProps {
  sessions: SessionSummary[];
  projects: ProjectSummary[];
  activeSessionId: string | null;
  onArchiveSession: (sessionId: string) => void | Promise<void>;
  onCreateSession: (
    topic: string,
    attachments: ComposerAttachment[],
    projectId?: string | null,
  ) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onOpenSession: (sessionId: string) => void;
  onRestoreSession: (sessionId: string) => void;
  onCreateProject: (name: string, description?: string) => void;
  onOpenProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onArchiveProject: (projectId: string) => void;
  onRestoreProject: (projectId: string) => void;
}

const INBOX_KEY = "__inbox__";

const AGENT_CARDS: Array<{
  provider: Provider;
  name: string;
  partner: string;
  color: string;
}> = [
  { provider: "openai", name: "George", partner: "Greta", color: "var(--color-george)" },
  { provider: "anthropic", name: "Cathy", partner: "Clara", color: "var(--color-cathy)" },
  { provider: "google", name: "Grace", partner: "Gaia", color: "var(--color-grace)" },
  { provider: "deepseek", name: "Douglas", partner: "Dara", color: "var(--color-douglas)" },
  { provider: "kimi", name: "Kate", partner: "Kira", color: "var(--color-kate)" },
  { provider: "qwen", name: "Quinn", partner: "Quincy", color: "var(--color-quinn)" },
  { provider: "minimax", name: "Mary", partner: "Mila", color: "var(--color-mary)" },
  { provider: "zhipu", name: "Zara", partner: "Zoe", color: "var(--color-zara)" },
];

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  openai: "GPT-5.4",
  anthropic: "Claude Opus 4.6",
  google: "Gemini 3.1 Pro",
  deepseek: "DeepSeek Reasoner",
  kimi: "Kimi K2.5",
  qwen: "Qwen 3.6 Plus",
  minimax: "MiniMax M2.7",
  zhipu: "GLM-5.1",
};

function getModelDisplayName(provider: string): string {
  return MODEL_DISPLAY_NAMES[provider] ?? provider;
}

const AGENT_COLORS: Record<string, string> = {
  openai: "#60a5fa",
  anthropic: "#fbbf24",
  google: "#34d399",
  deepseek: "#f87171",
  kimi: "#2dd4bf",
  qwen: "#22d3ee",
  minimax: "#f472b6",
  zhipu: "#a78bfa",
};

function CouncilCircleViz({ configured }: { configured: Provider[] }) {
  const cx = 100;
  const cy = 100;
  const rInner = 38;
  const rOuter = 68;
  const nodeR = 5;

  const nodes = AGENT_CARDS.map((agent, i) => {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const color = AGENT_COLORS[agent.provider] ?? "#9aa6bd";
    const active = configured.includes(agent.provider);
    return {
      inner: { x: cx + Math.cos(angle) * rInner, y: cy + Math.sin(angle) * rInner },
      outer: { x: cx + Math.cos(angle) * rOuter, y: cy + Math.sin(angle) * rOuter },
      color,
      active,
      name: agent.name,
      partner: agent.partner,
    };
  });

  return (
    <div className="council-circle-viz">
      <svg viewBox="0 0 200 200" width="420" height="420">
        <defs>
          <radialGradient id="cc-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(148, 163, 184, 0.06)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r="90" fill="url(#cc-glow)" />
        {/* Rings */}
        <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth="0.5" />
        <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth="0.5" />
        {/* Connecting lines */}
        {nodes.map((n, i) => (
          <line key={`line-${i}`} x1={n.inner.x} y1={n.inner.y} x2={n.outer.x} y2={n.outer.y}
            stroke={n.active ? n.color : "rgba(148,163,184,0.08)"} strokeWidth="0.5" opacity={n.active ? 0.3 : 0.15} />
        ))}
        {/* Outer nodes (observers) */}
        {nodes.map((n, i) => (
          <circle key={`outer-${i}`} cx={n.outer.x} cy={n.outer.y} r={nodeR * 0.65}
            fill={n.active ? n.color : "rgba(148,163,184,0.15)"} opacity={n.active ? 0.35 : 0.2} />
        ))}
        {/* Inner nodes (speakers) */}
        {nodes.map((n, i) => (
          <g key={`inner-${i}`}>
            {n.active && (
              <circle cx={n.inner.x} cy={n.inner.y} r={nodeR * 2} fill={n.color} opacity={0.08} />
            )}
            <circle cx={n.inner.x} cy={n.inner.y} r={nodeR}
              fill={n.active ? n.color : "rgba(148,163,184,0.2)"} opacity={n.active ? 0.85 : 0.3} />
          </g>
        ))}
      </svg>
    </div>
  );
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  completed: "Complete",
};

function describeAttachment(attachment: ComposerAttachment): string {
  switch (attachment.kind) {
    case "pdf":
      return "PDF - compact note";
    case "image":
      return "IMAGE - optimized";
    case "text":
      return "TEXT - extracted";
    default:
      return "FILE - extracted";
  }
}

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

function PlusIcon({ size = 16 }: { size?: number }) {
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
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function ImageIcon({ size = 16 }: { size?: number }) {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function CameraIcon({ size = 16 }: { size?: number }) {
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
      <path d="M14.5 4H9.5l-2 2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2.5l-2-2Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function FileIcon({ size = 16 }: { size?: number }) {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 15h6" />
      <path d="M9 11h3" />
    </svg>
  );
}

function XIcon({ size = 14 }: { size?: number }) {
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
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
  projects,
  activeSessionId,
  onArchiveSession,
  onCreateSession,
  onDeleteSession,
  onOpenSession,
  onRestoreSession,
  onCreateProject,
  onOpenProject: _onOpenProject,
  onDeleteProject,
  onArchiveProject,
  onRestoreProject,
}: HomeProps) {
  const [topic, setTopic] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set([INBOX_KEY]));
  const [showArchived, setShowArchived] = useState(false);
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [pendingProjectAction, setPendingProjectAction] = useState<ProjectSummary | null>(null);
  const [pendingSessionAction, setPendingSessionAction] = useState<SessionSummary | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [focusedAttachmentId, setFocusedAttachmentId] = useState<string | null>(null);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [showCameraCapture, setShowCameraCapture] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isOpeningSession, setIsOpeningSession] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const composerAttachmentsRef = useRef<ComposerAttachment[]>([]);
  const attachShellRef = useRef<HTMLDivElement | null>(null);
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
  const isArchivedActionTarget = pendingSessionAction?.archivedAt != null;

  const treeData = useMemo(() => {
    const activeSessions = sessions.filter((s) => s.archivedAt == null);
    const archivedSessions = sessions.filter((s) => s.archivedAt != null);

    // Group active sessions by projectId
    const inboxSessions = activeSessions.filter((s) => s.projectId == null);
    const activeProjects = projects.filter((p) => p.archivedAt == null);
    const projectSessionMap = new Map<string, SessionSummary[]>();
    for (const p of activeProjects) {
      projectSessionMap.set(p.id, []);
    }
    for (const s of activeSessions) {
      if (s.projectId != null && projectSessionMap.has(s.projectId)) {
        projectSessionMap.get(s.projectId)!.push(s);
      }
    }

    // Group archived sessions by projectId
    const archivedInbox = archivedSessions.filter((s) => s.projectId == null);
    const archivedProjects = projects.filter((p) => p.archivedAt != null);
    const archivedProjectSessionMap = new Map<string, SessionSummary[]>();
    // Include active projects that have archived sessions too
    for (const p of [...activeProjects, ...archivedProjects]) {
      if (!archivedProjectSessionMap.has(p.id)) {
        archivedProjectSessionMap.set(p.id, []);
      }
    }
    for (const s of archivedSessions) {
      if (s.projectId != null) {
        if (!archivedProjectSessionMap.has(s.projectId)) {
          archivedProjectSessionMap.set(s.projectId, []);
        }
        archivedProjectSessionMap.get(s.projectId)!.push(s);
      }
    }

    const totalArchived = archivedSessions.length + archivedProjects.length;

    return {
      inboxSessions,
      activeProjects,
      projectSessionMap,
      archivedInbox,
      archivedProjects,
      archivedProjectSessionMap,
      totalArchived,
    };
  }, [sessions, projects]);

  const clearComposerAttachments = () => {
    revokeComposerAttachmentPreviews(composerAttachments);
    setComposerAttachments([]);
    setFocusedAttachmentId(null);
  };

  const stopCameraStream = () => {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    mediaStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const appendAttachments = async (
    files: File[],
    source: "file-picker" | "photo-picker" | "camera",
  ) => {
    if (files.length === 0) return;

    try {
      const next = await createComposerAttachments(files, source);
      if (next.length === 0) {
        setAttachmentError("No selected files could be prepared for the session.");
        return;
      }
      setComposerAttachments((current) => [...current, ...next]);
      setAttachmentError(null);
    } catch (error) {
      console.error("Failed to load attachments:", error);
      setAttachmentError(error instanceof Error ? error.message : "Failed to prepare attachments.");
    }
  };

  const removeAttachment = (attachmentId: string) => {
    setComposerAttachments((current) => {
      const next = current.filter((attachment) => attachment.id !== attachmentId);
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        revokeComposerAttachmentPreview(removed);
      }
      return next;
    });
    setFocusedAttachmentId((current) => (current === attachmentId ? null : current));
  };

  const openCameraCapture = async () => {
    setCameraError(null);
    setShowAttachmentMenu(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      mediaStreamRef.current = stream;
      setShowCameraCapture(true);
    } catch (error) {
      console.error("Failed to open camera:", error);
      setCameraError("Camera access was denied or is unavailable on this Mac.");
      setShowCameraCapture(true);
    }
  };

  const captureCameraPhoto = async () => {
    const video = videoRef.current;
    if (!video || !mediaStreamRef.current) return;

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("Camera capture is unavailable in this window.");
      return;
    }

    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });

    if (!blob) {
      setCameraError("Could not capture the current camera frame.");
      return;
    }

    const file = new File([blob], `camera-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });

    await appendAttachments([file], "camera");
    stopCameraStream();
    setShowCameraCapture(false);
  };

  const handleStart = async () => {
    if (!topic.trim() || isOpeningSession) return;
    if (!hasAnyApiKey()) {
      setShowApiWarning(true);
      return;
    }

    setIsOpeningSession(true);
    try {
      await onCreateSession(topic.trim(), composerAttachments, focusedProjectId);
      clearComposerAttachments();
      setAttachmentError(null);
    } catch (error) {
      console.error("Failed to open session:", error);
      setAttachmentError(error instanceof Error ? error.message : "Failed to open session.");
    } finally {
      setIsOpeningSession(false);
    }
  };

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!pendingSessionAction) return;

    const stillExists = sessions.some((session) => session.id === pendingSessionAction.id);
    if (!stillExists) {
      setPendingSessionAction(null);
    }
  }, [pendingSessionAction, sessions]);

  useEffect(() => {
    if (!showCameraCapture || !videoRef.current || !mediaStreamRef.current) return;
    videoRef.current.srcObject = mediaStreamRef.current;
    void videoRef.current.play().catch(() => {
      setCameraError("Camera preview could not start.");
    });
  }, [showCameraCapture]);

  useEffect(() => {
    if (!showAttachmentMenu) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!attachShellRef.current?.contains(event.target as Node)) {
        setShowAttachmentMenu(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [showAttachmentMenu]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setShowSettings(true);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (event.shiftKey) {
          imageInputRef.current?.click();
        } else {
          uploadInputRef.current?.click();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void openCameraCapture();
        return;
      }

      if (event.key === "Escape") {
        if (showAttachmentMenu) {
          setShowAttachmentMenu(false);
        }
        if (showCameraCapture) {
          stopCameraStream();
          setShowCameraCapture(false);
        }
        if (pendingSessionAction) {
          setPendingSessionAction(null);
        }
      }

      if ((event.key === "Backspace" || event.key === "Delete") && focusedAttachmentId) {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement ||
          activeElement?.getAttribute("contenteditable") === "true"
        ) {
          return;
        }
        event.preventDefault();
        removeAttachment(focusedAttachmentId);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [focusedAttachmentId, pendingSessionAction, showAttachmentMenu, showCameraCapture]);

  useEffect(() => {
    composerAttachmentsRef.current = composerAttachments;
  }, [composerAttachments]);

  useEffect(() => {
    return () => {
      stopCameraStream();
      revokeComposerAttachmentPreviews(composerAttachmentsRef.current);
    };
  }, []);

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
            <div className="workstation-brand-label" style={{ fontFamily: "var(--font-mono)", textTransform: "lowercase", letterSpacing: "0.02em" }}>socratic council</div>
          </div>
        </div>

        <div className="workstation-sidebar-actions">
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="workstation-sidebar-button"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <GearIcon size={16} />
            <span>Settings</span>
          </button>
          <div className="workstation-sidebar-pill" style={{ fontFamily: "var(--font-mono)" }}>
            <ArchiveIcon size={14} />
            <span>{sessions.length} saved locally</span>
          </div>
        </div>

        <div className="workstation-sidebar-section">
          <div className="workstation-thread-list">
            {/* Active Projects */}
            {treeData.activeProjects.map((project) => {
              const projectSessions = treeData.projectSessionMap.get(project.id) ?? [];
              const isExpanded = expandedProjects.has(project.id);
              const isFocused = focusedProjectId === project.id;
              return (
                <div key={project.id}>
                  <div className="workstation-project-row-wrap">
                    <button
                      type="button"
                      onClick={() => {
                        setFocusedProjectId(project.id);
                        toggleProject(project.id);
                      }}
                      className="workstation-project-row"
                      style={{
                        borderColor: isFocused ? "rgba(20,184,166,0.24)" : undefined,
                        background: isFocused ? "rgba(20,184,166,0.08)" : undefined,
                        flex: 1,
                      }}
                    >
                      <span
                        className="workstation-project-chevron"
                        style={{
                          transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                        }}
                      >
                        ▶
                      </span>
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {project.name}
                      </span>
                      {projectSessions.length > 0 && (
                        <span className="workstation-project-count">{projectSessions.length}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="workstation-thread-action"
                      onClick={() => setPendingProjectAction(project)}
                      title="Manage project"
                      aria-label={`Manage ${project.name}`}
                      style={{ marginTop: 0, width: "1.8rem", height: "1.8rem" }}
                    >
                      <MoreIcon size={12} />
                    </button>
                  </div>
                  {isExpanded && (
                    <div
                      className="workstation-expand-panel"
                      style={{
                        paddingLeft: 12,
                        marginTop: 4,
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.5rem",
                      }}
                    >
                      {projectSessions.length > 0 ? (
                        projectSessions.map((session) => (
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
                                  <span
                                    className={`session-status session-status-${session.status}`}
                                  >
                                    {STATUS_LABELS[session.status]}
                                  </span>
                                  <span style={{ fontFamily: "var(--font-mono)" }}>{formatRelativeTime(session.updatedAt)}</span>
                                </div>
                                <div className="workstation-thread-title">{session.title}</div>
                                <div className="workstation-thread-foot">
                                  <span>{session.currentTurn} turns</span>
                                </div>
                              </button>
                              <button
                                type="button"
                                className="workstation-thread-action"
                                aria-label={`Manage ${session.title}`}
                                title="Archive or delete session"
                                onClick={() => setPendingSessionAction(session)}
                              >
                                <MoreIcon size={14} />
                              </button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="workstation-empty-state" style={{ padding: "0.5rem 0" }}>
                          No sessions yet.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* New Project button */}
            <button
              type="button"
              onClick={() => setShowNewProject(true)}
              className="workstation-new-project-btn"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              <PlusIcon size={12} />
              <span>New Project</span>
            </button>

            {/* Sessions — unassigned sessions */}
            <div>
              <button
                type="button"
                onClick={() => {
                  setFocusedProjectId(null);
                  toggleProject(INBOX_KEY);
                }}
                className="workstation-project-row"
                style={{
                  borderColor: focusedProjectId == null ? "rgba(20,184,166,0.24)" : undefined,
                  background: focusedProjectId == null ? "rgba(20,184,166,0.08)" : undefined,
                }}
              >
                <span
                  className="workstation-project-chevron"
                  style={{
                    transform: expandedProjects.has(INBOX_KEY) ? "rotate(90deg)" : "rotate(0deg)",
                  }}
                >
                  ▶
                </span>
                <span style={{ flex: 1 }}>Sessions</span>
                {treeData.inboxSessions.length > 0 && (
                  <span className="workstation-project-count">{treeData.inboxSessions.length}</span>
                )}
              </button>
              {expandedProjects.has(INBOX_KEY) && treeData.inboxSessions.length > 0 && (
                <div
                  className="workstation-expand-panel"
                  style={{
                    paddingLeft: 12,
                    marginTop: 4,
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  {treeData.inboxSessions.map((session) => (
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
                            <span style={{ fontFamily: "var(--font-mono)" }}>{formatRelativeTime(session.updatedAt)}</span>
                          </div>
                          <div className="workstation-thread-title">{session.title}</div>
                          <div className="workstation-thread-foot">
                            <span>{session.currentTurn} turns</span>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="workstation-thread-action"
                          aria-label={`Manage ${session.title}`}
                          title="Archive or delete session"
                          onClick={() => setPendingSessionAction(session)}
                        >
                          <MoreIcon size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Archived section */}
            {treeData.totalArchived > 0 && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setShowArchived((prev) => !prev)}
                  className="workstation-project-row"
                  style={{
                    background: "transparent",
                    border: "none",
                    borderTop: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 0,
                    color: "rgba(255,255,255,0.35)",
                    fontSize: "0.68rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "8px 4px 4px",
                  }}
                >
                  <span
                    className="workstation-project-chevron"
                    style={{
                      transform: showArchived ? "rotate(90deg)" : "rotate(0deg)",
                      fontSize: 8,
                    }}
                  >
                    ▶
                  </span>
                  <span>Archived</span>
                </button>
                {showArchived && (
                  <div
                    className="workstation-expand-panel"
                    style={{
                      opacity: 0.55,
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.5rem",
                      marginTop: 4,
                    }}
                  >
                    {/* Archived projects with their sessions */}
                    {[...treeData.activeProjects, ...treeData.archivedProjects]
                      .filter(
                        (p) =>
                          (treeData.archivedProjectSessionMap.get(p.id)?.length ?? 0) > 0 ||
                          p.archivedAt != null,
                      )
                      .map((project) => {
                        const archivedProjectSessions =
                          treeData.archivedProjectSessionMap.get(project.id) ?? [];
                        const archiveKey = `archived:${project.id}`;
                        const isExpanded = expandedProjects.has(archiveKey);
                        if (archivedProjectSessions.length === 0 && project.archivedAt == null)
                          return null;
                        return (
                          <div key={project.id}>
                            <div className="workstation-project-row-wrap">
                              <button
                                type="button"
                                onClick={() => toggleProject(archiveKey)}
                                className="workstation-project-row"
                                style={{ flex: 1 }}
                              >
                                <span
                                  className="workstation-project-chevron"
                                  style={{
                                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                    fontSize: 8,
                                  }}
                                >
                                  ▶
                                </span>
                                <span
                                  style={{
                                    flex: 1,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {project.name}
                                </span>
                                {archivedProjectSessions.length > 0 && (
                                  <span className="workstation-project-count">
                                    {archivedProjectSessions.length}
                                  </span>
                                )}
                              </button>
                              <button
                                type="button"
                                className="workstation-thread-action"
                                onClick={() => setPendingProjectAction(project)}
                                aria-label={`Manage ${project.name}`}
                                style={{ width: "1.6rem", height: "1.6rem", marginTop: 0 }}
                              >
                                <MoreIcon size={11} />
                              </button>
                            </div>
                            {isExpanded && archivedProjectSessions.length > 0 && (
                              <div
                                className="workstation-expand-panel"
                                style={{
                                  paddingLeft: 12,
                                  marginTop: 4,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "0.5rem",
                                }}
                              >
                                {archivedProjectSessions.map((session) => (
                                  <div key={session.id} className="workstation-thread">
                                    <div className="workstation-thread-header">
                                      <button
                                        type="button"
                                        onClick={() => onOpenSession(session.id)}
                                        className="workstation-thread-open"
                                      >
                                        <div className="workstation-thread-title">
                                          {session.title}
                                        </div>
                                        <div className="workstation-thread-foot">
                                          <span>{session.currentTurn} turns</span>
                                          <span>Archived</span>
                                        </div>
                                      </button>
                                      <button
                                        type="button"
                                        className="workstation-thread-action"
                                        onClick={() => setPendingSessionAction(session)}
                                        aria-label={`Manage ${session.title}`}
                                      >
                                        <MoreIcon size={14} />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                    {/* Archived orphan sessions */}
                    {treeData.archivedInbox.map((session) => (
                      <div key={session.id} className="workstation-thread">
                        <div className="workstation-thread-header">
                          <button
                            type="button"
                            onClick={() => onOpenSession(session.id)}
                            className="workstation-thread-open"
                          >
                            <div className="workstation-thread-title">{session.title}</div>
                            <div className="workstation-thread-foot">
                              <span>{session.currentTurn} turns</span>
                              <span>Archived</span>
                            </div>
                          </button>
                          <button
                            type="button"
                            className="workstation-thread-action"
                            onClick={() => setPendingSessionAction(session)}
                            aria-label={`Manage ${session.title}`}
                          >
                            <MoreIcon size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Empty state */}
            {treeData.inboxSessions.length === 0 &&
              treeData.activeProjects.length === 0 &&
              treeData.totalArchived === 0 && (
                <div className="workstation-empty-state">
                  Your council sessions will appear here after the first run.
                </div>
              )}
          </div>
        </div>
      </aside>

      <main className="workstation-main">
        <div className="workstation-stage">
          <section className="workstation-composer-card">
            <div className="workstation-composer-header">
              <CouncilCircleViz configured={configuredProviders} />
            </div>

            <div className="workstation-composer-body">
              <div className="workstation-input-shell">
                <div ref={attachShellRef} className="workstation-attach-shell">
                  <button
                    type="button"
                    className={`workstation-attach-button ${showAttachmentMenu ? "is-open" : ""}`}
                    onClick={() => setShowAttachmentMenu((current) => !current)}
                    aria-label="Add attachments"
                    title="Add attachments"
                  >
                    <PlusIcon size={16} />
                  </button>
                  {showAttachmentMenu && (
                    <div className="workstation-attach-menu">
                      <button
                        type="button"
                        className="workstation-attach-menu-item"
                        onClick={() => {
                          setShowAttachmentMenu(false);
                          uploadInputRef.current?.click();
                        }}
                      >
                        <FileIcon size={16} />
                        <span>Upload Files…</span>
                        <span className="workstation-attach-shortcut">Cmd+O</span>
                      </button>
                      <button
                        type="button"
                        className="workstation-attach-menu-item"
                        onClick={() => {
                          setShowAttachmentMenu(false);
                          imageInputRef.current?.click();
                        }}
                      >
                        <ImageIcon size={16} />
                        <span>Choose Photo…</span>
                        <span className="workstation-attach-shortcut">Shift+Cmd+O</span>
                      </button>
                      <button
                        type="button"
                        className="workstation-attach-menu-item"
                        onClick={() => {
                          void openCameraCapture();
                        }}
                      >
                        <CameraIcon size={16} />
                        <span>Take Photo…</span>
                        <span className="workstation-attach-shortcut">Shift+Cmd+C</span>
                      </button>
                    </div>
                  )}
                </div>
                <input
                  id="topic-input"
                  type="text"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleStart();
                    }
                  }}
                  placeholder="What should the council pressure-test next?"
                  className="elegant-input workstation-input"
                />
                <button
                  type="button"
                  onClick={() => {
                    void handleStart();
                  }}
                  disabled={!topic.trim() || isOpeningSession}
                  className="workstation-launch-button"
                >
                  <span>{isOpeningSession ? "Opening…" : "Open Session"}</span>
                  <ArrowIcon size={18} />
                </button>
              </div>
              <div className="workstation-input-help" style={{ fontFamily: "var(--font-mono)" }}>
                Upload images, PDFs, DOCX, code, text, and other files. Large non-image files are
                compacted locally.
              </div>

              {composerAttachments.length > 0 && (
                <div className="workstation-attachment-strip">
                  <div className="workstation-attachment-strip-header">
                    <span>{buildAttachmentListLabel(composerAttachments)}</span>
                    <span>Delete or Backspace removes the focused card.</span>
                  </div>
                  <div className="workstation-attachment-list">
                    {composerAttachments.map((attachment) => (
                      <button
                        key={attachment.id}
                        type="button"
                        className={`workstation-attachment-chip ${
                          focusedAttachmentId === attachment.id ? "is-focused" : ""
                        }`}
                        onClick={() => setFocusedAttachmentId(attachment.id)}
                        onFocus={() => setFocusedAttachmentId(attachment.id)}
                      >
                        {attachment.previewUrl ? (
                          <img
                            src={attachment.previewUrl}
                            alt={attachment.name}
                            className="workstation-attachment-thumb"
                          />
                        ) : (
                          <div className="workstation-attachment-fallback-icon">
                            {attachment.kind === "image" ? (
                              <ImageIcon size={16} />
                            ) : (
                              <FileIcon size={16} />
                            )}
                          </div>
                        )}
                        <div className="workstation-attachment-copy">
                          <span>{attachment.name}</span>
                          <span>{describeAttachment(attachment)}</span>
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          className="workstation-attachment-remove"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeAttachment(attachment.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              removeAttachment(attachment.id);
                            }
                          }}
                          aria-label={`Remove ${attachment.name}`}
                        >
                          <XIcon size={12} />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="workstation-suggestion-row">
                {sampleTopics.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setTopic(sample)}
                    className="workstation-suggestion-chip"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {sample}
                  </button>
                ))}
              </div>

              {showApiWarning && !hasAnyApiKey() && (
                <div className="workstation-warning">
                  <AlertIcon size={18} />
                  <div>Configure at least one provider before opening a new council session.</div>
                  <button
                    type="button"
                    onClick={() => setShowSettings(true)}
                    className="workstation-inline-link"
                  >
                    Open settings
                  </button>
                </div>
              )}

              {attachmentError && (
                <div className="workstation-warning">
                  <AlertIcon size={18} />
                  <div>{attachmentError}</div>
                </div>
              )}
            </div>
          </section>

          <aside className="workstation-inspector">
            <div className="workstation-panel-heading" style={{ fontFamily: "var(--font-mono)", marginBottom: "0.6rem" }}>
              Council Rack
            </div>
            <div className="workstation-agent-list">
              {AGENT_CARDS.map((agent) => {
                const configured = configuredProviders.includes(agent.provider);
                const modelName = configured ? getModelDisplayName(agent.provider) : "not configured";
                return (
                  <div
                    key={agent.provider}
                    className={`workstation-agent-row ${configured ? "is-ready" : ""}`}
                  >
                    <ProviderIcon provider={agent.provider} size={20} />
                    <div className="workstation-agent-row-info">
                      <span className="workstation-agent-row-name" style={{ color: configured ? agent.color : undefined }}>
                        {agent.name}<span style={{ opacity: 0.35 }}> & {agent.partner}</span>
                      </span>
                      <span className="workstation-agent-row-model">{modelName}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="workstation-inspector-footer">
              <span className="workstation-inspector-stat" style={{ fontFamily: "var(--font-mono)" }}>
                {configuredProviders.length}/{AGENT_CARDS.length} ready
              </span>
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

      <input
        ref={uploadInputRef}
        type="file"
        accept="*/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = "";
          void appendAttachments(files, "file-picker");
        }}
      />

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = "";
          void appendAttachments(files, "photo-picker");
        }}
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

      {showCameraCapture && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              stopCameraStream();
              setShowCameraCapture(false);
            }
          }}
        >
          <div className="modal-content camera-capture-modal">
            <div className="session-action-eyebrow">Camera Capture</div>
            <h2 className="session-action-title">Take a photo for this session</h2>
            <p className="session-action-copy">
              Capture a quick image and attach it to the opening prompt. Use Escape to cancel.
            </p>
            <div className="camera-capture-stage">
              {cameraError ? (
                <div className="camera-capture-empty">{cameraError}</div>
              ) : (
                <video ref={videoRef} autoPlay playsInline muted className="camera-capture-video" />
              )}
            </div>
            <div className="session-action-buttons camera-capture-buttons">
              <button
                type="button"
                className="session-action-button is-neutral"
                onClick={() => {
                  stopCameraStream();
                  setShowCameraCapture(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="session-action-button is-archive"
                onClick={() => {
                  stopCameraStream();
                  setShowCameraCapture(false);
                  void openCameraCapture();
                }}
              >
                Retry
              </button>
              <button
                type="button"
                className="session-action-button is-delete"
                onClick={() => {
                  void captureCameraPhoto();
                }}
                disabled={Boolean(cameraError)}
              >
                Capture
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewProject && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowNewProject(false);
              setNewProjectName("");
              setNewProjectDescription("");
            }
          }}
        >
          <div className="modal-content session-action-modal">
            <div className="session-action-eyebrow">New Project</div>
            <h2 className="session-action-title">Create a research project</h2>
            <p className="session-action-copy">
              Group related council sessions and build a shared dossier of evidence that persists
              across discussions.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
              <input
                type="text"
                placeholder="Project name"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                maxLength={120}
                style={{
                  fontSize: 14,
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: "0.5rem",
                  color: "#fff",
                  outline: "none",
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newProjectName.trim()) {
                    onCreateProject(newProjectName.trim(), newProjectDescription.trim());
                    setShowNewProject(false);
                    setNewProjectName("");
                    setNewProjectDescription("");
                  }
                }}
              />
              <textarea
                placeholder="Description (optional)"
                value={newProjectDescription}
                onChange={(e) => setNewProjectDescription(e.target.value)}
                style={{
                  fontSize: 13,
                  padding: "10px 12px",
                  minHeight: 60,
                  resize: "vertical",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: "0.5rem",
                  color: "#fff",
                  outline: "none",
                }}
              />
            </div>
            <div
              className="session-action-buttons"
              style={{ marginTop: 14, gridTemplateColumns: "1fr 1fr" }}
            >
              <button
                type="button"
                className="session-action-button is-neutral"
                onClick={() => {
                  setShowNewProject(false);
                  setNewProjectName("");
                  setNewProjectDescription("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="session-action-button is-archive"
                disabled={!newProjectName.trim()}
                onClick={() => {
                  onCreateProject(newProjectName.trim(), newProjectDescription.trim());
                  setShowNewProject(false);
                  setNewProjectName("");
                  setNewProjectDescription("");
                }}
              >
                Create Project
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingProjectAction && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPendingProjectAction(null);
            }
          }}
        >
          <div className="modal-content session-action-modal">
            <div className="session-action-eyebrow">
              {pendingProjectAction.archivedAt != null ? "Archived Project" : "Project Actions"}
            </div>
            <h2 className="session-action-title">{pendingProjectAction.name}</h2>
            <p className="session-action-copy">
              {pendingProjectAction.archivedAt != null
                ? "Restore returns this project to your list. Delete removes it and all its sessions permanently."
                : "Archive keeps this project saved but hides it. Delete removes it and all its sessions permanently."}
            </p>
            <div className="session-action-buttons">
              <button
                type="button"
                className="session-action-button is-neutral"
                onClick={() => setPendingProjectAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="session-action-button is-archive"
                onClick={() => {
                  if (pendingProjectAction.archivedAt != null) {
                    onRestoreProject(pendingProjectAction.id);
                  } else {
                    onArchiveProject(pendingProjectAction.id);
                  }
                  setPendingProjectAction(null);
                }}
              >
                {pendingProjectAction.archivedAt != null ? (
                  <RestoreIcon size={15} />
                ) : (
                  <ArchiveIcon size={15} />
                )}
                <span>{pendingProjectAction.archivedAt != null ? "Restore" : "Archive"}</span>
              </button>
              <button
                type="button"
                className="session-action-button is-delete"
                onClick={() => {
                  onDeleteProject(pendingProjectAction.id);
                  setPendingProjectAction(null);
                }}
              >
                <TrashIcon size={15} />
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
