import type { AgentId as CouncilAgentId, Message as SharedMessage } from "@socratic-council/shared";

import type { Provider } from "../stores/config";
import {
  deleteSessionAttachmentBlobs,
  persistSessionAttachments,
  summarizeSessionAttachments,
  type ComposerAttachment,
  type SessionAttachment,
} from "./attachments";

const SESSION_INDEX_KEY = "socratic-council-session-index-v1";
const SESSION_KEY_PREFIX = "socratic-council-session:";

export type SessionStatus = "draft" | "running" | "paused" | "completed";
export type SessionPhase = "discussion" | "resolution" | "completed";

export interface SessionMessage extends SharedMessage {
  isStreaming?: boolean;
  latencyMs?: number;
  error?: string;
  quotedMessageIds?: string[];
  toolEvents?: SessionToolEvent[];
  thinking?: string;
  fullResponse?: string;
  reactions?: Partial<Record<string, { count: number; by: string[] }>>;
  displayName?: string;
  displayProvider?: Provider;
}

export interface SessionToolEvent {
  id: string;
  name: string;
  summary: string;
  output: string;
  error?: string;
  timestamp: number;
}

export interface ModeratorUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedUSD: number;
  pricingAvailable: boolean;
}

export interface DuoLogueSnapshot {
  participants: [CouncilAgentId, CouncilAgentId];
  remainingTurns: number;
}

export interface SessionRuntimeSnapshot {
  phase: SessionPhase;
  cyclePending: CouncilAgentId[];
  previousSpeaker: CouncilAgentId | null;
  recentSpeakers: CouncilAgentId[];
  whisperBonuses: Record<CouncilAgentId, number>;
  lastWhisperKey: string | null;
  lastModeratorKey: string | null;
  lastModeratorBalanceKey: string | null;
  lastModeratorSynthesisTurn: number;
  moderatorResolutionPromptPosted: boolean;
  moderatorFinalSummaryPosted: boolean;
  resolutionQueue: CouncilAgentId[];
  resolutionNoticePosted: boolean;
}

export interface DiscussionSession {
  id: string;
  topic: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  archivedAt: number | null;
  status: SessionStatus;
  currentTurn: number;
  totalTokens: {
    input: number;
    output: number;
  };
  moderatorUsage: ModeratorUsageSnapshot;
  messages: SessionMessage[];
  errors: string[];
  attachments: SessionAttachment[];
  duoLogue: DuoLogueSnapshot | null;
  runtime: SessionRuntimeSnapshot;
}

export interface SessionSummary {
  id: string;
  title: string;
  topic: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  archivedAt: number | null;
  status: SessionStatus;
  currentTurn: number;
  messageCount: number;
  attachmentCount: number;
  preview: string;
}

const AGENT_IDS: CouncilAgentId[] = [
  "george",
  "cathy",
  "grace",
  "douglas",
  "kate",
  "quinn",
  "mary",
];

const EMPTY_MODERATOR_USAGE: ModeratorUsageSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedUSD: 0,
  pricingAvailable: false,
};

function createEmptyWhisperBonuses(): Record<CouncilAgentId, number> {
  return {
    george: 0,
    cathy: 0,
    grace: 0,
    douglas: 0,
    kate: 0,
    quinn: 0,
    mary: 0,
  };
}

function createEmptyRuntime(): SessionRuntimeSnapshot {
  return {
    phase: "discussion",
    cyclePending: [...AGENT_IDS],
    previousSpeaker: null,
    recentSpeakers: [],
    whisperBonuses: createEmptyWhisperBonuses(),
    lastWhisperKey: null,
    lastModeratorKey: null,
    lastModeratorBalanceKey: null,
    lastModeratorSynthesisTurn: 0,
    moderatorResolutionPromptPosted: false,
    moderatorFinalSummaryPosted: false,
    resolutionQueue: [],
    resolutionNoticePosted: false,
  };
}

function getStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

function createSessionStorageKey(id: string): string {
  return `${SESSION_KEY_PREFIX}${id}`;
}

function createSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isCouncilAgent(value: unknown): value is CouncilAgentId {
  return typeof value === "string" && AGENT_IDS.includes(value as CouncilAgentId);
}

function normalizeStatus(value: unknown): SessionStatus {
  if (value === "draft" || value === "running" || value === "paused" || value === "completed") {
    return value;
  }
  return "draft";
}

function normalizePhase(value: unknown, status: SessionStatus): SessionPhase {
  if (status === "completed") return "completed";
  if (value === "resolution" || value === "closing") return "resolution";
  if (value === "completed") return "completed";
  return "discussion";
}

function normalizeReactions(value: unknown): SessionMessage["reactions"] | undefined {
  if (!value || typeof value !== "object") return undefined;

  const result: SessionMessage["reactions"] = {};
  for (const [reactionId, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const count = clampNumber((raw as { count?: number }).count);
    const rawBy = (raw as { by?: unknown[] }).by;
    const by = Array.isArray(rawBy)
      ? rawBy.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];

    if (count <= 0 && by.length === 0) continue;

    result[reactionId] = {
      count: count > 0 ? count : by.length,
      by,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeToolEvent(input: unknown): SessionToolEvent | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<SessionToolEvent>;
  const id = cleanText(record.id);
  const name = cleanText(record.name);
  const summary = cleanText(record.summary);
  const output = cleanText(record.output);

  if (!id || !name || !summary) return null;

  return {
    id,
    name,
    summary,
    output,
    ...(record.error ? { error: cleanText(record.error) } : {}),
    timestamp: clampNumber(record.timestamp, Date.now()),
  };
}

function normalizeMessage(input: unknown): SessionMessage | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<SessionMessage>;
  const id = cleanText(record.id);
  const content = cleanText(record.content);
  const agentId = cleanText(record.agentId);
  const timestamp = clampNumber(record.timestamp);

  if (!id || !agentId || !timestamp) return null;
  if (record.isStreaming) return null;

  return {
    id,
    agentId: agentId as SessionMessage["agentId"],
    content,
    timestamp,
    ...(record.tokens && typeof record.tokens === "object"
      ? {
          tokens: {
            input: clampNumber(record.tokens.input),
            output: clampNumber(record.tokens.output),
            ...(record.tokens.reasoning != null
              ? { reasoning: clampNumber(record.tokens.reasoning) }
              : {}),
          },
        }
      : {}),
    ...(record.metadata && typeof record.metadata === "object"
      ? {
          metadata: {
            model: cleanText(record.metadata.model) as NonNullable<
              SessionMessage["metadata"]
            >["model"],
            latencyMs: clampNumber(record.metadata.latencyMs),
            ...(record.metadata.bidScore != null
              ? { bidScore: clampNumber(record.metadata.bidScore) }
              : {}),
          },
        }
      : {}),
    ...(record.latencyMs != null ? { latencyMs: clampNumber(record.latencyMs) } : {}),
    ...(record.error ? { error: cleanText(record.error) } : {}),
    ...(Array.isArray(record.quotedMessageIds)
      ? {
          quotedMessageIds: record.quotedMessageIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        }
      : {}),
    ...(Array.isArray(record.toolEvents)
      ? {
          toolEvents: record.toolEvents
            .map((entry) => normalizeToolEvent(entry))
            .filter((entry): entry is SessionToolEvent => Boolean(entry)),
        }
      : {}),
    ...(record.thinking ? { thinking: cleanText(record.thinking) } : {}),
    ...(record.fullResponse ? { fullResponse: cleanText(record.fullResponse) } : {}),
    ...(record.displayName ? { displayName: cleanText(record.displayName) } : {}),
    ...(record.displayProvider ? { displayProvider: record.displayProvider } : {}),
    ...(normalizeReactions(record.reactions)
      ? { reactions: normalizeReactions(record.reactions) }
      : {}),
  };
}

function normalizeRuntime(input: unknown, status: SessionStatus): SessionRuntimeSnapshot {
  const fallback = createEmptyRuntime();
  if (!input || typeof input !== "object") {
    return {
      ...fallback,
      phase: normalizePhase(undefined, status),
    };
  }

  const record = input as Partial<SessionRuntimeSnapshot> & {
    moderatorClosurePosted?: unknown;
    closingQueue?: unknown;
    closingNoticePosted?: unknown;
  };
  const whisperBonuses = createEmptyWhisperBonuses();
  for (const agentId of AGENT_IDS) {
    whisperBonuses[agentId] = clampNumber(record.whisperBonuses?.[agentId]);
  }

  return {
    phase: normalizePhase(record.phase, status),
    cyclePending: Array.isArray(record.cyclePending)
      ? record.cyclePending.filter(isCouncilAgent)
      : fallback.cyclePending,
    previousSpeaker: isCouncilAgent(record.previousSpeaker) ? record.previousSpeaker : null,
    recentSpeakers: Array.isArray(record.recentSpeakers)
      ? record.recentSpeakers.filter(isCouncilAgent)
      : [],
    whisperBonuses,
    lastWhisperKey: typeof record.lastWhisperKey === "string" ? record.lastWhisperKey : null,
    lastModeratorKey: typeof record.lastModeratorKey === "string" ? record.lastModeratorKey : null,
    lastModeratorBalanceKey:
      typeof record.lastModeratorBalanceKey === "string" ? record.lastModeratorBalanceKey : null,
    lastModeratorSynthesisTurn: clampNumber(record.lastModeratorSynthesisTurn),
    moderatorResolutionPromptPosted: Boolean(
      record.moderatorResolutionPromptPosted ?? record.moderatorClosurePosted,
    ),
    moderatorFinalSummaryPosted: Boolean(record.moderatorFinalSummaryPosted),
    resolutionQueue: Array.isArray(record.resolutionQueue)
      ? record.resolutionQueue.filter(isCouncilAgent)
      : Array.isArray(record.closingQueue)
        ? record.closingQueue.filter(isCouncilAgent)
        : [],
    resolutionNoticePosted: Boolean(record.resolutionNoticePosted ?? record.closingNoticePosted),
  };
}

function buildPreview(
  messages: SessionMessage[],
  topic: string,
  attachments: SessionAttachment[],
): string {
  const source =
    [...messages].reverse().find((message) => {
      const text = (message.content || message.fullResponse || "").trim();
      return text.length > 0 && !message.error;
    })?.content ??
    (summarizeSessionAttachments(attachments) || topic);

  return source.replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeAttachment(input: unknown): SessionAttachment | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<SessionAttachment>;
  const id = cleanText(record.id).trim();
  const name = cleanText(record.name).trim();
  if (!id || !name) return null;

  const kind =
    record.kind === "image" ||
    record.kind === "pdf" ||
    record.kind === "text" ||
    record.kind === "binary"
      ? record.kind
      : "binary";
  const source =
    record.source === "file-picker" ||
    record.source === "photo-picker" ||
    record.source === "camera"
      ? record.source
      : "file-picker";

  return {
    id,
    name,
    mimeType: cleanText(record.mimeType, "application/octet-stream"),
    size: clampNumber(record.size),
    kind,
    source,
    addedAt: clampNumber(record.addedAt, Date.now()),
    width: record.width == null ? null : clampNumber(record.width),
    height: record.height == null ? null : clampNumber(record.height),
    fallbackText: cleanText(record.fallbackText),
    ...(record.searchable != null ? { searchable: Boolean(record.searchable) } : {}),
    ...(record.extractedChars != null
      ? { extractedChars: clampNumber(record.extractedChars) }
      : {}),
  };
}

function buildTitle(topic: string): string {
  return topic.replace(/\s+/g, " ").trim().slice(0, 80);
}

function buildSummary(session: DiscussionSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    topic: session.topic,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastOpenedAt: session.lastOpenedAt,
    archivedAt: session.archivedAt,
    status: session.status,
    currentTurn: session.currentTurn,
    messageCount: session.messages.length,
    attachmentCount: session.attachments.length,
    preview: buildPreview(session.messages, session.topic, session.attachments),
  };
}

function readIndex(): SessionSummary[] {
  const storage = getStorage();
  if (!storage) return [];

  try {
    const raw = storage.getItem(SESSION_INDEX_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is SessionSummary => !!entry && typeof entry === "object")
      .map((entry) => ({
        id: cleanText(entry.id),
        title: cleanText(entry.title),
        topic: cleanText(entry.topic),
        createdAt: clampNumber(entry.createdAt),
        updatedAt: clampNumber(entry.updatedAt),
        lastOpenedAt: clampNumber(entry.lastOpenedAt),
        archivedAt: entry.archivedAt == null ? null : clampNumber(entry.archivedAt),
        status: normalizeStatus(entry.status),
        currentTurn: clampNumber(entry.currentTurn),
        messageCount: clampNumber(entry.messageCount),
        attachmentCount: clampNumber(entry.attachmentCount),
        preview: cleanText(entry.preview),
      }))
      .filter((entry) => entry.id.length > 0);
  } catch (error) {
    console.error("Failed to read session index:", error);
    return [];
  }
}

function writeIndex(index: SessionSummary[]): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
  } catch (error) {
    console.error("Failed to write session index:", error);
  }
}

function normalizeDiscussionSession(input: unknown): DiscussionSession | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<DiscussionSession>;
  const topic = cleanText(record.topic).trim();
  const id = cleanText(record.id).trim();

  if (!topic || !id) return null;

  const status = normalizeStatus(record.status);
  const messages = Array.isArray(record.messages)
    ? record.messages
        .map((message) => normalizeMessage(message))
        .filter((message): message is SessionMessage => Boolean(message))
    : [];
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .map((attachment) => normalizeAttachment(attachment))
        .filter((attachment): attachment is SessionAttachment => Boolean(attachment))
    : [];

  const createdAt = clampNumber(record.createdAt, Date.now());
  const updatedAt = clampNumber(record.updatedAt, createdAt);
  const lastOpenedAt = clampNumber(record.lastOpenedAt, updatedAt);

  return {
    id,
    topic,
    title: cleanText(record.title, buildTitle(topic)) || buildTitle(topic),
    createdAt,
    updatedAt,
    lastOpenedAt,
    archivedAt: record.archivedAt == null ? null : clampNumber(record.archivedAt),
    status,
    currentTurn: clampNumber(record.currentTurn),
    totalTokens: {
      input: clampNumber(record.totalTokens?.input),
      output: clampNumber(record.totalTokens?.output),
    },
    moderatorUsage: {
      inputTokens: clampNumber(record.moderatorUsage?.inputTokens),
      outputTokens: clampNumber(record.moderatorUsage?.outputTokens),
      reasoningTokens: clampNumber(record.moderatorUsage?.reasoningTokens),
      estimatedUSD: clampNumber(record.moderatorUsage?.estimatedUSD),
      pricingAvailable: Boolean(record.moderatorUsage?.pricingAvailable),
    },
    messages,
    errors: Array.isArray(record.errors)
      ? record.errors.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [],
    attachments,
    duoLogue:
      record.duoLogue &&
      isCouncilAgent(record.duoLogue.participants?.[0]) &&
      isCouncilAgent(record.duoLogue.participants?.[1])
        ? {
            participants: [record.duoLogue.participants[0], record.duoLogue.participants[1]],
            remainingTurns: clampNumber(record.duoLogue.remainingTurns),
          }
        : null,
    runtime: normalizeRuntime(record.runtime, status),
  };
}

function replaceIndexEntry(index: SessionSummary[], summary: SessionSummary): SessionSummary[] {
  const next = index.filter((entry) => entry.id !== summary.id);
  next.unshift(summary);
  return next.sort(
    (a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt),
  );
}

export function listSessionSummaries(): SessionSummary[] {
  return readIndex().sort(
    (a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt),
  );
}

export function saveDiscussionSession(session: DiscussionSession): DiscussionSession {
  const storage = getStorage();
  if (!storage) {
    return session;
  }

  const normalized = normalizeDiscussionSession(session);
  if (!normalized) {
    throw new Error("Invalid session payload");
  }

  const safeSession: DiscussionSession = {
    ...normalized,
    messages: normalized.messages.filter((message) => !message.isStreaming),
    attachments: [...normalized.attachments].sort((a, b) => a.addedAt - b.addedAt),
    runtime: {
      ...normalized.runtime,
      phase:
        normalized.status === "completed"
          ? "completed"
          : normalized.runtime.phase === "completed"
            ? "discussion"
            : normalized.runtime.phase,
    },
  };

  try {
    storage.setItem(createSessionStorageKey(safeSession.id), JSON.stringify(safeSession));
    writeIndex(replaceIndexEntry(readIndex(), buildSummary(safeSession)));
  } catch (error) {
    console.error("Failed to save session:", error);
  }

  return safeSession;
}

export function loadDiscussionSession(id: string): DiscussionSession | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(createSessionStorageKey(id));
    if (!raw) return null;

    const parsed = normalizeDiscussionSession(JSON.parse(raw));
    if (!parsed) return null;

    return parsed;
  } catch (error) {
    console.error("Failed to load session:", error);
    return null;
  }
}

export function deleteDiscussionSession(id: string): boolean {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.removeItem(createSessionStorageKey(id));
    writeIndex(readIndex().filter((entry) => entry.id !== id));
    return true;
  } catch (error) {
    console.error("Failed to delete session:", error);
    return false;
  }
}

export async function deleteDiscussionSessionWithAttachments(id: string): Promise<boolean> {
  const deleted = deleteDiscussionSession(id);
  if (!deleted) return false;

  try {
    await deleteSessionAttachmentBlobs(id);
  } catch (error) {
    console.error("Failed to delete attachment blobs:", error);
  }

  return true;
}

function updateArchivedState(id: string, archivedAt: number | null): DiscussionSession | null {
  const existing = loadDiscussionSession(id);
  if (!existing) return null;

  return saveDiscussionSession({
    ...existing,
    archivedAt,
    ...(archivedAt == null ? { lastOpenedAt: Date.now() } : {}),
  });
}

export function archiveDiscussionSession(id: string): DiscussionSession | null {
  return updateArchivedState(id, Date.now());
}

export function restoreDiscussionSession(id: string): DiscussionSession | null {
  return updateArchivedState(id, null);
}

export function touchDiscussionSession(id: string): DiscussionSession | null {
  const existing = loadDiscussionSession(id);
  if (!existing) return null;

  return saveDiscussionSession({
    ...existing,
    archivedAt: null,
    lastOpenedAt: Date.now(),
  });
}

export async function createDiscussionSession(
  topic: string,
  pendingAttachments: ComposerAttachment[] = [],
): Promise<DiscussionSession> {
  const trimmed = topic.trim();
  const now = Date.now();
  const id = createSessionId();
  const attachments =
    pendingAttachments.length > 0 ? await persistSessionAttachments(id, pendingAttachments) : [];
  const session: DiscussionSession = {
    id,
    topic: trimmed,
    title: buildTitle(trimmed),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    archivedAt: null,
    status: "draft",
    currentTurn: 0,
    totalTokens: { input: 0, output: 0 },
    moderatorUsage: { ...EMPTY_MODERATOR_USAGE },
    messages: [],
    errors: [],
    attachments,
    duoLogue: null,
    runtime: createEmptyRuntime(),
  };

  return saveDiscussionSession(session);
}

export function stabilizeStoredSessions(): SessionSummary[] {
  const summaries = listSessionSummaries();
  const stabilized: SessionSummary[] = [];

  for (const summary of summaries) {
    const session = loadDiscussionSession(summary.id);
    if (!session) {
      continue;
    }

    if (session.status === "running") {
      const next = saveDiscussionSession({
        ...session,
        status: "paused",
      });
      stabilized.push(buildSummary(next));
      continue;
    }

    stabilized.push(buildSummary(session));
  }

  writeIndex(
    stabilized.sort(
      (a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt),
    ),
  );

  return stabilized;
}
