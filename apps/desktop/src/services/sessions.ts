import type { AgentId as CouncilAgentId, Message as SharedMessage } from "@socratic-council/shared";

import type { Provider } from "../stores/config";
import {
  deleteSessionAttachmentBlobs,
  persistSessionAttachments,
  summarizeSessionAttachments,
  type ComposerAttachment,
  type SessionAttachment,
} from "./attachments";
import { decryptString, encryptString, isEnvelopedCiphertext } from "./vault";

const SESSION_INDEX_KEY = "socratic-council-session-index-v1";
const SESSION_KEY_PREFIX = "socratic-council-session:";

export class SessionPersistenceError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SessionPersistenceError";
    this.cause = cause;
  }
}

export type SessionStatus = "draft" | "running" | "paused" | "completed";
export type SessionPhase = "discussion" | "resolution" | "completed";
export type EndVoteChoice = "yes" | "no";
export type EndVoteBoardStatus = "active" | "complete" | "passed" | "failed";
export type ModeratorConclusionStatus = "consensus" | "majority" | "unresolved";

export interface EndVoteSnapshot {
  id: string;
  proposer: CouncilAgentId;
  round: 1 | 2;
  queue: CouncilAgentId[];
  firstRoundVotes: Partial<Record<CouncilAgentId, EndVoteChoice>>;
  firstRoundReasons: Partial<Record<CouncilAgentId, string>>;
  secondRoundVotes: Partial<Record<CouncilAgentId, EndVoteChoice>>;
  secondRoundReasons: Partial<Record<CouncilAgentId, string>>;
}

export interface EndVoteBallotSnapshot {
  voteId: string;
  round: 1 | 2;
  choice: EndVoteChoice;
  reason?: string;
}

export interface EndVoteBoardSnapshot {
  voteId: string;
  proposer: CouncilAgentId;
  round: 1 | 2;
  threshold: number;
  totalAgents: number;
  agentOrder: CouncilAgentId[];
  votes: Partial<Record<CouncilAgentId, EndVoteChoice>>;
  reasons: Partial<Record<CouncilAgentId, string>>;
  status: EndVoteBoardStatus;
  outcome?: string;
}

export interface ModeratorConclusionSnapshot {
  status: ModeratorConclusionStatus;
  summary: string;
  score: number;
  reason: string;
  next?: string;
}

export type ResearchConfidence = "high" | "medium" | "low";

export type ResearchReportPhase =
  | "planning"
  | "research"
  | "synthesis"
  | "formatting"
  | "complete"
  | "error";

export interface ResearchCitation {
  id: string; // short id like "c1"
  messageId: string; // existing chat message id
  quote: string; // ~200-char excerpt
}

export interface ResearchSubQuestion {
  id: string;
  question: string;
  findings: string; // markdown summary of what the transcript says
  citations: string[]; // citation ids referencing DeepResearchReportSnapshot.citations
  confidence: ResearchConfidence;
}

export interface ResearchSection {
  id: string;
  heading: string;
  body: string; // markdown, with inline citation tokens like [c1]
  confidence: ResearchConfidence;
}

export interface DeepResearchReportSnapshot {
  phase: ResearchReportPhase;
  title: string; // short headline (~6-10 words)
  abstract: string; // 3-4 sentence narrative lede
  subQuestions: ResearchSubQuestion[];
  sections: ResearchSection[];
  citations: ResearchCitation[];
  confidence: ResearchConfidence;
  generatedAt: number;
  modelId: string;
  error?: string;
}

export interface HandoffSnapshot {
  from: CouncilAgentId;
  to: CouncilAgentId;
  question: string;
  sourceMessageId: string;
  timestamp: number;
}

export interface SessionMessage extends SharedMessage {
  isStreaming?: boolean;
  latencyMs?: number;
  thinkingMs?: number;
  error?: string;
  attachmentIds?: string[];
  quotedMessageIds?: string[];
  toolEvents?: SessionToolEvent[];
  thinking?: string;
  fullResponse?: string;
  reactions?: Partial<Record<string, { count: number; by: string[] }>>;
  displayName?: string;
  displayProvider?: Provider;
  requestedEnd?: boolean;
  endVoteBallot?: EndVoteBallotSnapshot;
  endVoteBoard?: EndVoteBoardSnapshot;
  moderatorConclusion?: ModeratorConclusionSnapshot;
  deepResearchReport?: DeepResearchReportSnapshot;
  observerNote?: ObserverNoteSnapshot;
  isResolution?: boolean;
}

export interface ObserverNoteSnapshot {
  observerId: string;
  observerName: string;
  partnerId: string;
  partnerName: string;
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
  endVote: EndVoteSnapshot | null;
  pendingHandoff: HandoffSnapshot | null;
}

export interface DiscussionSession {
  id: string;
  topic: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  archivedAt: number | null;
  projectId: string | null;
  status: SessionStatus;
  currentTurn: number;
  totalTokens: {
    input: number;
    output: number;
  };
  moderatorUsage: ModeratorUsageSnapshot;
  observerUsage: ModeratorUsageSnapshot;
  messages: SessionMessage[];
  errors: string[];
  attachments: SessionAttachment[];
  duoLogue: DuoLogueSnapshot | null;
  runtime: SessionRuntimeSnapshot;
  canvasStates?: Record<string, unknown>;
  /**
   * Session branching (wave 2.7). When present, this session was forked from
   * another session at a specific message. The UI surfaces a "↪ branched
   * from …" crumb so users can navigate back to the parent.
   */
  parentSessionId?: string;
  parentMessageId?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  topic: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  archivedAt: number | null;
  projectId: string | null;
  status: SessionStatus;
  currentTurn: number;
  messageCount: number;
  attachmentCount: number;
  preview: string;
  parentSessionId?: string;
  parentMessageId?: string;
}

const AGENT_IDS: CouncilAgentId[] = [
  "george",
  "cathy",
  "grace",
  "douglas",
  "kate",
  "quinn",
  "mary",
  "zara",
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
    zara: 0,
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
    endVote: null,
    pendingHandoff: null,
  };
}

function getStorage(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

/**
 * Read an item from localStorage, transparently decrypting if the value is
 * stored as a vault envelope. Legacy plaintext values are returned as-is so
 * sessions saved before encryption still load. Malformed ciphertexts return
 * null (treated as absent — caller can decide how to handle).
 */
function readSecureItem(storage: Storage, key: string): string | null {
  const raw = storage.getItem(key);
  if (raw == null) return null;
  if (!isEnvelopedCiphertext(raw)) return raw;
  try {
    return decryptString(raw);
  } catch (error) {
    console.error(`[sessions] Failed to decrypt storage key "${key}":`, error);
    return null;
  }
}

/**
 * Write an item to localStorage through the vault. If the vault isn't ready
 * (pre-initVault or non-Tauri environment), encryptString returns the value
 * unchanged — data is still persisted, just not encrypted yet. The next save
 * after `initVault()` completes will encrypt it.
 */
function writeSecureItem(storage: Storage, key: string, value: string): void {
  storage.setItem(key, encryptString(value));
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

function isEndVoteChoice(value: unknown): value is EndVoteChoice {
  return value === "yes" || value === "no";
}

function isEndVoteBoardStatus(value: unknown): value is EndVoteBoardStatus {
  return value === "active" || value === "complete" || value === "passed" || value === "failed";
}

function isModeratorConclusionStatus(value: unknown): value is ModeratorConclusionStatus {
  return value === "consensus" || value === "majority" || value === "unresolved";
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

function normalizeReasonRecord(value: unknown): Partial<Record<CouncilAgentId, string>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const reasons: Partial<Record<CouncilAgentId, string>> = {};
  for (const [agentId, reason] of Object.entries(value)) {
    const cleaned = cleanText(reason).trim();
    if (isCouncilAgent(agentId) && cleaned) {
      reasons[agentId] = cleaned;
    }
  }

  return reasons;
}

function normalizeHandoff(input: unknown): HandoffSnapshot | null {
  if (!input || typeof input !== "object") return null;

  const record = input as Partial<HandoffSnapshot>;
  const from = isCouncilAgent(record.from) ? record.from : null;
  const to = isCouncilAgent(record.to) ? record.to : null;
  const question = cleanText(record.question).trim();
  const sourceMessageId = cleanText(record.sourceMessageId).trim();

  if (!from || !to || !question || !sourceMessageId) {
    return null;
  }

  return {
    from,
    to,
    question,
    sourceMessageId,
    timestamp: clampNumber(record.timestamp, Date.now()),
  };
}

function normalizeEndVoteBallot(input: unknown): EndVoteBallotSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined;

  const record = input as Partial<EndVoteBallotSnapshot>;
  const voteId = cleanText(record.voteId);
  if (!voteId || !isEndVoteChoice(record.choice)) return undefined;

  return {
    voteId,
    round: record.round === 2 ? 2 : 1,
    choice: record.choice,
    ...(cleanText(record.reason).trim() ? { reason: cleanText(record.reason).trim() } : {}),
  };
}

function normalizeEndVoteBoard(input: unknown): EndVoteBoardSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined;

  const record = input as Partial<EndVoteBoardSnapshot>;
  const voteId = cleanText(record.voteId);
  const proposer = isCouncilAgent(record.proposer) ? record.proposer : null;
  if (!voteId || !proposer) return undefined;

  return {
    voteId,
    proposer,
    round: record.round === 2 ? 2 : 1,
    threshold: Math.max(1, clampNumber(record.threshold, 1)),
    totalAgents: Math.max(1, clampNumber(record.totalAgents, 1)),
    agentOrder: Array.isArray(record.agentOrder) ? record.agentOrder.filter(isCouncilAgent) : [],
    votes:
      record.votes && typeof record.votes === "object"
        ? Object.fromEntries(
            Object.entries(record.votes).filter(
              ([agentId, choice]) => isCouncilAgent(agentId) && isEndVoteChoice(choice),
            ),
          )
        : {},
    reasons: normalizeReasonRecord(record.reasons),
    status: isEndVoteBoardStatus(record.status) ? record.status : "active",
    ...(cleanText(record.outcome).trim() ? { outcome: cleanText(record.outcome).trim() } : {}),
  };
}

function normalizeModeratorConclusion(input: unknown): ModeratorConclusionSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined;

  const record = input as Partial<ModeratorConclusionSnapshot>;
  const status = isModeratorConclusionStatus(record.status) ? record.status : null;
  const summary = cleanText(record.summary).trim();
  const reason = cleanText(record.reason).trim();
  if (!status || !summary || !reason) return undefined;

  const score = Math.max(0, Math.min(10, Math.round(clampNumber(record.score, 0))));

  return {
    status,
    summary,
    score,
    reason,
    ...(cleanText(record.next).trim() ? { next: cleanText(record.next).trim() } : {}),
  };
}

const RESEARCH_CONFIDENCE_VALUES = new Set<ResearchConfidence>(["high", "medium", "low"]);
const RESEARCH_PHASE_VALUES = new Set<ResearchReportPhase>([
  "planning",
  "research",
  "synthesis",
  "formatting",
  "complete",
  "error",
]);

function normalizeResearchConfidence(value: unknown): ResearchConfidence {
  return typeof value === "string" && RESEARCH_CONFIDENCE_VALUES.has(value as ResearchConfidence)
    ? (value as ResearchConfidence)
    : "medium";
}

function normalizeResearchPhase(value: unknown): ResearchReportPhase {
  return typeof value === "string" && RESEARCH_PHASE_VALUES.has(value as ResearchReportPhase)
    ? (value as ResearchReportPhase)
    : "complete";
}

function normalizeResearchCitations(value: unknown): ResearchCitation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ResearchCitation | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Partial<ResearchCitation>;
      const id = cleanText(record.id).trim();
      const messageId = cleanText(record.messageId).trim();
      const quote = cleanText(record.quote).trim();
      if (!id || !messageId) return null;
      return { id, messageId, quote };
    })
    .filter((entry): entry is ResearchCitation => Boolean(entry));
}

function normalizeResearchSubQuestions(value: unknown): ResearchSubQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ResearchSubQuestion | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Partial<ResearchSubQuestion>;
      const id = cleanText(record.id).trim();
      const question = cleanText(record.question).trim();
      if (!id || !question) return null;
      return {
        id,
        question,
        findings: cleanText(record.findings),
        citations: Array.isArray(record.citations)
          ? record.citations.filter((c): c is string => typeof c === "string")
          : [],
        confidence: normalizeResearchConfidence(record.confidence),
      };
    })
    .filter((entry): entry is ResearchSubQuestion => Boolean(entry));
}

function normalizeResearchSections(value: unknown): ResearchSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ResearchSection | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Partial<ResearchSection>;
      const id = cleanText(record.id).trim();
      const heading = cleanText(record.heading).trim();
      const body = cleanText(record.body);
      if (!id || !heading) return null;
      return {
        id,
        heading,
        body,
        confidence: normalizeResearchConfidence(record.confidence),
      };
    })
    .filter((entry): entry is ResearchSection => Boolean(entry));
}

function normalizeDeepResearchReport(input: unknown): DeepResearchReportSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<DeepResearchReportSnapshot>;
  return {
    phase: normalizeResearchPhase(record.phase),
    title: cleanText(record.title),
    abstract: cleanText(record.abstract),
    subQuestions: normalizeResearchSubQuestions(record.subQuestions),
    sections: normalizeResearchSections(record.sections),
    citations: normalizeResearchCitations(record.citations),
    confidence: normalizeResearchConfidence(record.confidence),
    generatedAt: clampNumber(record.generatedAt),
    modelId: cleanText(record.modelId),
    ...(cleanText(record.error).trim() ? { error: cleanText(record.error).trim() } : {}),
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
    ...(Array.isArray(record.attachmentIds)
      ? {
          attachmentIds: record.attachmentIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        }
      : {}),
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
    ...(record.requestedEnd ? { requestedEnd: Boolean(record.requestedEnd) } : {}),
    ...(normalizeEndVoteBallot(record.endVoteBallot)
      ? { endVoteBallot: normalizeEndVoteBallot(record.endVoteBallot) }
      : {}),
    ...(normalizeEndVoteBoard(record.endVoteBoard)
      ? { endVoteBoard: normalizeEndVoteBoard(record.endVoteBoard) }
      : {}),
    ...(normalizeModeratorConclusion(record.moderatorConclusion)
      ? { moderatorConclusion: normalizeModeratorConclusion(record.moderatorConclusion) }
      : {}),
    ...(normalizeDeepResearchReport(record.deepResearchReport)
      ? { deepResearchReport: normalizeDeepResearchReport(record.deepResearchReport) }
      : {}),
    ...(normalizeReactions(record.reactions)
      ? { reactions: normalizeReactions(record.reactions) }
      : {}),
    ...(record.observerNote && typeof record.observerNote === "object"
      ? { observerNote: record.observerNote }
      : {}),
    ...(record.isResolution ? { isResolution: true } : {}),
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

  const normalizeVoteRecord = (value: unknown): Partial<Record<CouncilAgentId, EndVoteChoice>> => {
    if (!value || typeof value !== "object") {
      return {};
    }

    const votes: Partial<Record<CouncilAgentId, EndVoteChoice>> = {};
    for (const [agentId, choice] of Object.entries(value)) {
      if (isCouncilAgent(agentId) && isEndVoteChoice(choice)) {
        votes[agentId] = choice;
      }
    }
    return votes;
  };

  const endVote =
    record.endVote && typeof record.endVote === "object"
      ? (() => {
          const raw = record.endVote as Partial<EndVoteSnapshot>;
          const id = cleanText(raw.id) || "end_vote_legacy";
          const proposer = isCouncilAgent(raw.proposer) ? raw.proposer : null;
          if (!proposer) return null;

          return {
            id,
            proposer,
            round: raw.round === 2 ? 2 : 1,
            queue: Array.isArray(raw.queue) ? raw.queue.filter(isCouncilAgent) : [],
            firstRoundVotes: normalizeVoteRecord(raw.firstRoundVotes),
            firstRoundReasons: normalizeReasonRecord(raw.firstRoundReasons),
            secondRoundVotes: normalizeVoteRecord(raw.secondRoundVotes),
            secondRoundReasons: normalizeReasonRecord(raw.secondRoundReasons),
          } satisfies EndVoteSnapshot;
        })()
      : null;
  const pendingHandoff = normalizeHandoff(record.pendingHandoff);

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
    endVote,
    pendingHandoff,
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

function normalizeCanvasStates(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;

  const result: Record<string, unknown> = {};
  for (const [agentId, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isCouncilAgent(agentId)) continue;
    if (!raw || typeof raw !== "object") continue;

    const record = raw as {
      agentId?: unknown;
      sections?: unknown;
      lastUpdatedTurn?: unknown;
      lastUpdatedAt?: unknown;
    };

    if (!Array.isArray(record.sections)) continue;

    const sections = record.sections
      .map((section) => {
        if (!section || typeof section !== "object") return null;
        const sec = section as {
          id?: unknown;
          label?: unknown;
          text?: unknown;
          updatedAt?: unknown;
        };
        const id = cleanText(sec.id).trim();
        const label = cleanText(sec.label).trim();
        const text = cleanText(sec.text);
        if (!id || !label) return null;
        return {
          id,
          label,
          text,
          updatedAt: clampNumber(sec.updatedAt, Date.now()),
        };
      })
      .filter((section): section is NonNullable<typeof section> => Boolean(section));

    result[agentId] = {
      agentId,
      sections,
      lastUpdatedTurn: clampNumber(record.lastUpdatedTurn),
      lastUpdatedAt: clampNumber(record.lastUpdatedAt, Date.now()),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
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
    projectId: session.projectId,
    status: session.status,
    currentTurn: session.currentTurn,
    messageCount: session.messages.length,
    attachmentCount: session.attachments.length,
    preview: buildPreview(session.messages, session.topic, session.attachments),
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.parentMessageId ? { parentMessageId: session.parentMessageId } : {}),
  };
}

/**
 * Branch a session at a specific message (wave 2.7). The new session contains
 * every message up to AND including the fork point; runtime state is reset so
 * the branch can diverge freely. Returns the newly-created branch session —
 * persisted to localStorage just like any other session.
 *
 * Callers decide what the branch should change (topic framing, roster, etc.)
 * by editing the returned session BEFORE running it. Attachments are NOT
 * cloned — the branch reuses the parent's attachment ids (IndexedDB blobs
 * are deduplicated implicitly).
 */
export function branchDiscussionSession(
  parent: DiscussionSession,
  forkMessageId: string,
): DiscussionSession {
  const idx = parent.messages.findIndex((m) => m.id === forkMessageId);
  const cutoff = idx >= 0 ? idx + 1 : parent.messages.length;
  const messages = parent.messages.slice(0, cutoff);

  const now = Date.now();
  const branchId = `${parent.id}_br_${now.toString(36)}`;
  const branch: DiscussionSession = {
    ...parent,
    id: branchId,
    title: `${parent.title} (branch)`,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    archivedAt: null,
    status: "paused",
    messages,
    errors: [],
    runtime: {
      ...parent.runtime,
      phase: "discussion",
      cyclePending: [...AGENT_IDS],
      previousSpeaker: null,
      recentSpeakers: [],
      endVote: null,
      pendingHandoff: null,
    },
    parentSessionId: parent.id,
    parentMessageId: forkMessageId,
  };

  return saveDiscussionSession(branch);
}

function readIndex(): SessionSummary[] {
  const storage = getStorage();
  if (!storage) return [];

  try {
    const raw = readSecureItem(storage, SESSION_INDEX_KEY);
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
        projectId: typeof entry.projectId === "string" ? entry.projectId : null,
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
  writeSecureItem(storage, SESSION_INDEX_KEY, JSON.stringify(index));
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
    projectId: typeof record.projectId === "string" ? record.projectId : null,
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
    observerUsage: {
      inputTokens: clampNumber(record.observerUsage?.inputTokens),
      outputTokens: clampNumber(record.observerUsage?.outputTokens),
      reasoningTokens: clampNumber(record.observerUsage?.reasoningTokens),
      estimatedUSD: clampNumber(record.observerUsage?.estimatedUSD),
      pricingAvailable: Boolean(record.observerUsage?.pricingAvailable),
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
    ...(normalizeCanvasStates(record.canvasStates)
      ? { canvasStates: normalizeCanvasStates(record.canvasStates) }
      : {}),
    ...(typeof record.parentSessionId === "string" && record.parentSessionId.length > 0
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(typeof record.parentMessageId === "string" && record.parentMessageId.length > 0
      ? { parentMessageId: record.parentMessageId }
      : {}),
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
    writeSecureItem(
      storage,
      createSessionStorageKey(safeSession.id),
      JSON.stringify(safeSession),
    );
    writeIndex(replaceIndexEntry(readIndex(), buildSummary(safeSession)));
  } catch (error) {
    console.error("Failed to save session:", error);
    throw new SessionPersistenceError(
      "Failed to save the session locally. Free up browser storage space and try again.",
      error,
    );
  }

  return safeSession;
}

export function loadDiscussionSession(id: string): DiscussionSession | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = readSecureItem(storage, createSessionStorageKey(id));
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

  try {
    return saveDiscussionSession({
      ...existing,
      archivedAt,
      ...(archivedAt == null ? { lastOpenedAt: Date.now() } : {}),
    });
  } catch (error) {
    console.error("Failed to update archived state:", error);
    return null;
  }
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

  try {
    return saveDiscussionSession({
      ...existing,
      archivedAt: null,
      lastOpenedAt: Date.now(),
    });
  } catch (error) {
    console.error("Failed to touch session:", error);
    return null;
  }
}

export async function createDiscussionSession(
  topic: string,
  pendingAttachments: ComposerAttachment[] = [],
  projectId: string | null = null,
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
    projectId,
    status: "draft",
    currentTurn: 0,
    totalTokens: { input: 0, output: 0 },
    moderatorUsage: { ...EMPTY_MODERATOR_USAGE },
    observerUsage: { ...EMPTY_MODERATOR_USAGE },
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
      try {
        const next = saveDiscussionSession({
          ...session,
          status: "paused",
        });
        stabilized.push(buildSummary(next));
      } catch (error) {
        console.error("Failed to stabilize running session:", error);
        stabilized.push(summary);
      }
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

export function listSessionSummariesByProject(projectId: string | null): SessionSummary[] {
  return listSessionSummaries().filter((s) => s.projectId === projectId);
}
