import { useState, useEffect, useRef, useCallback, useMemo, forwardRef } from "react";
import type { CSSProperties, HTMLAttributes } from "react";
import type { Page } from "../App";
import { useConfig, PROVIDER_INFO, type Provider } from "../stores/config";
import { callProvider, apiLogger, type ChatMessage as APIChatMessage } from "../services/api";
import {
  getAttachmentTransportMode,
  loadSessionAttachmentBlobs,
  summarizeSessionAttachments,
} from "../services/attachments";
import {
  type DiscussionSession,
  type ModeratorUsageSnapshot,
  type SessionMessage as PersistedSessionMessage,
  type SessionPhase,
  type SessionStatus,
  type SessionToolEvent,
} from "../services/sessions";
import { getToolPrompt, runToolCall, type ToolCall, type ToolContext } from "../services/tools";
import { CouncilMark } from "../components/CouncilMark";
import { ProviderIcon, SystemIcon, UserIcon } from "../components/icons/ProviderIcons";
import {
  ReactionIcon,
  DEFAULT_REACTION,
  REACTION_CATALOG,
  type ReactionId,
} from "../components/icons/ReactionIcons";
import { Markdown } from "../components/Markdown";
import { ConversationSearch } from "../components/ConversationSearch";
import { ConversationExport } from "../components/ConversationExport";
import { ConflictGraph } from "../components/ConflictGraph";
import {
  ConflictDetector,
  CostTrackerEngine,
  ConversationMemoryManager,
  createMemoryManager,
  FairnessManager,
} from "@socratic-council/core";
import { calculateMessageCost } from "../utils/cost";
import { createStreamingToolCallDetector, extractActions } from "../utils/toolActions";
import { splitIntoInlineQuoteSegments, stripQuoteTokens } from "../utils/inlineQuotes";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type {
  ConflictDetection,
  CostTracker,
  PairwiseConflict,
  WhisperMessage,
  AgentId as CouncilAgentId,
  ModelId,
} from "@socratic-council/shared";

interface ChatProps {
  session: DiscussionSession;
  onNavigate: (page: Page, sessionId?: string) => void;
  onPersistSession: (session: DiscussionSession) => void;
}

type ChatMessage = PersistedSessionMessage;
type APIAttachment = NonNullable<APIChatMessage["attachments"]>[number];

interface BiddingRound {
  scores: Record<CouncilAgentId, number>;
  winner: CouncilAgentId;
}

type AgentId = CouncilAgentId | "system" | "user" | "tool";

interface DuoLogueState {
  participants: [CouncilAgentId, CouncilAgentId];
  remainingTurns: number;
}

// Model display names mapping - includes both full dated IDs and aliases
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // OpenAI
  "gpt-5.4": "GPT-5.4",
  "gpt-5.3-chat-latest": "GPT-5.3 Instant",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.2-pro": "GPT-5.2 Pro",
  "gpt-5.2": "GPT-5.2",
  "gpt-5-mini": "GPT-5 Mini",
  o3: "o3",
  "o4-mini": "o4-mini",
  "gpt-4o": "GPT-4o",
  // Anthropic - Full dated IDs (recommended for production)
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5-20251101": "Claude Opus 4.5",
  "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-opus-4-1-20250410": "Claude Opus 4.1",
  // Anthropic - Legacy aliases (kept for backwards compatibility)
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "claude-3-opus-20240229": "Claude 3 Opus",
  // Google
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  // DeepSeek
  "deepseek-reasoner": "DeepSeek Reasoner",
  "deepseek-chat": "DeepSeek Chat",
  // Kimi
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2-thinking": "Kimi K2 Thinking",
  "moonshot-v1-128k": "Moonshot V1 128K",
  // Qwen
  "qwen3.5-plus": "Qwen 3.5 Plus",
  // MiniMax
  "MiniMax-M2.5": "MiniMax M2.5",
  "minimax-m2.5": "MiniMax M2.5",
};

const GROUP_CHAT_GUIDELINES = `
You are in a real-time group chat. Keep responses short, pointed, and decision-oriented.

Rules:
- 1–2 short paragraphs (max ~140 words).
- Be assertive: challenge weak claims directly and name the specific assumption you reject.
- Avoid headings and long bullet lists (keep it chatty). Use them only if plain text is clearly insufficient.
- Directly address a specific point from someone else by name.
- Push the discussion forward by doing one primary thing: add one new claim/example/counterpoint, or narrow the group toward a recommendation using evidence or decision criteria.
- Do not reopen settled points unless you have new evidence or a better standard.
- If the discussion is mature, prefer synthesis and choice over novelty.
- Include one concrete test, falsifiable criterion, or counterexample when possible.
- If your answer depends on exact wording from attached files or current facts, research first before answering.
- Proactively call oracle.file_search for attached-file evidence and oracle.web_search for current external facts when that would materially improve the answer.
- If you know you need a tool, emit only the @tool(name, {args}) line and stop. The app will execute it and return control to you.
- If a retrieved passage looks incomplete, do one more targeted search until you have enough surrounding context.
- Call tools early instead of burning time in hidden reasoning before the search starts.
- Ask at most one concrete question, and only if it materially helps the group decide. Do not force a question every turn.
- If the Moderator shifts the room toward resolution, stop broadening the debate and help land a final result.
- Never emit tool_use, tool_call, function_call, XML tool tags, or provider-specific tool syntax. Use only the literal @tool(name, {args}) format.

Markdown:
- Markdown is supported (GFM tables, links, **bold**, \`code\`, fenced code blocks, and LaTeX math via $...$ / $$...$$).
- Prefer plain text for normal conversations. Use Markdown only when it materially improves clarity (math, CS, structured data).
- If you use math/code, write the *real* formula/code (not placeholders).

Quoting/Reactions:
- You MUST include @quote(MSG_ID) for a specific prior message. You can quote MULTIPLE messages from different speakers or even the same speaker: @quote(MSG_A) @quote(MSG_B).
- If it fits, include @react(MSG_ID, 👍|👎|❤️|😂|😮|😢|😡|✨|🎉).

${getToolPrompt()}
`;

const BASE_SYSTEM_PROMPT = (
  name: string,
) => `You are ${name} in a group chat with George, Cathy, Grace, Douglas, Kate, Quinn, and Mary.

Do NOT adopt a persona or specialty. Speak as yourself, and keep the tone natural.

Proactive behavior requirements:
- If someone is vague, force precision by asking for a measurable claim.
- If someone makes a strong claim, pressure-test it with one concrete challenge.
- If the room is converging too quickly without enough evidence, introduce one serious dissenting angle.
- Once the evidence is good enough, help the group converge on a defensible recommendation instead of reopening settled points.
- If someone has been quiet recently, invite them by name into the exact point of dispute.
- The goal is not endless debate. Surface the real disagreement early, then help the group reach a clear closing result.

${GROUP_CHAT_GUIDELINES}`;

const MODERATOR_SYSTEM_PROMPT = `You are the Moderator in a group chat with George, Cathy, Grace, Douglas, Kate, Quinn, and Mary.

Your job: keep the discussion focused, fair, rigorous, and productive.

Rules:
- Speak briefly (1–4 sentences, max ~120 words).
- Prefer plain text. Use Markdown only if plain text is clearly insufficient.
- Ask at most ONE question.
- You may do any of the following when useful:
  1) kickoff framing with one measurable objective,
  2) periodic synthesis (agreed/disputed/unresolved),
  3) participation balancing (invite underrepresented voices),
  4) evidence-quality checks (claim vs evidence),
  5) drift correction back to topic,
  6) contradiction spotlighting with a clarifying question,
  7) near-end transition into resolution with clear decision criteria,
  8) final outcome publication after the resolution round.
- Keep interventions sparse and high-signal to avoid unnecessary cost.
- You may suggest who should respond next by name.
- At the end, publish the official closing result instead of leaving the room with another open question.
- Do NOT include @quote(...), @react(...), or @tool(...).
- Do NOT impersonate any agent.`;

const AGENT_CONFIG: Record<
  AgentId,
  {
    name: string;
    color: string;
    bgColor: string;
    borderColor: string;
    provider: Provider;
    systemPrompt: string;
  }
> = {
  george: {
    name: "George",
    color: "text-george",
    bgColor: "bg-george/10",
    borderColor: "border-george",
    provider: "openai",
    systemPrompt: BASE_SYSTEM_PROMPT("George"),
  },
  cathy: {
    name: "Cathy",
    color: "text-cathy",
    bgColor: "bg-cathy/10",
    borderColor: "border-cathy",
    provider: "anthropic",
    systemPrompt: BASE_SYSTEM_PROMPT("Cathy"),
  },
  grace: {
    name: "Grace",
    color: "text-grace",
    bgColor: "bg-grace/10",
    borderColor: "border-grace",
    provider: "google",
    systemPrompt: BASE_SYSTEM_PROMPT("Grace"),
  },
  douglas: {
    name: "Douglas",
    color: "text-douglas",
    bgColor: "bg-douglas/10",
    borderColor: "border-douglas",
    provider: "deepseek",
    systemPrompt: BASE_SYSTEM_PROMPT("Douglas"),
  },
  kate: {
    name: "Kate",
    color: "text-kate",
    bgColor: "bg-kate/10",
    borderColor: "border-kate",
    provider: "kimi",
    systemPrompt: BASE_SYSTEM_PROMPT("Kate"),
  },
  quinn: {
    name: "Quinn",
    color: "text-quinn",
    bgColor: "bg-quinn/10",
    borderColor: "border-quinn",
    provider: "qwen",
    systemPrompt: BASE_SYSTEM_PROMPT("Quinn"),
  },
  mary: {
    name: "Mary",
    color: "text-mary",
    bgColor: "bg-mary/10",
    borderColor: "border-mary",
    provider: "minimax",
    systemPrompt: BASE_SYSTEM_PROMPT("Mary"),
  },
  system: {
    name: "System",
    color: "text-ink-500",
    bgColor: "bg-white/60",
    borderColor: "border-line-soft",
    provider: "openai",
    systemPrompt: "",
  },
  tool: {
    name: "Tool",
    color: "text-ink-500",
    bgColor: "bg-white/60",
    borderColor: "border-line-soft",
    provider: "openai",
    systemPrompt: "",
  },
  user: {
    name: "You",
    color: "text-ink-900",
    bgColor: "bg-white/80",
    borderColor: "border-line-soft",
    provider: "openai",
    systemPrompt: "",
  },
};

const AGENT_IDS: CouncilAgentId[] = [
  "george",
  "cathy",
  "grace",
  "douglas",
  "kate",
  "quinn",
  "mary",
];

const isCouncilAgent = (id: unknown): id is CouncilAgentId =>
  AGENT_IDS.includes(id as CouncilAgentId);

const isModeratorMessage = (msg: unknown): boolean => {
  if (!msg || typeof msg !== "object") return false;
  const record = msg as Record<string, unknown>;
  return record.agentId === "system" && record.displayName === "Moderator";
};

const REACTION_IDS = REACTION_CATALOG;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_TOOL_ITERATIONS = 2;
const DEFAULT_MODERATOR_USAGE: ModeratorUsageSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedUSD: 0,
  pricingAvailable: false,
};

function createWhisperBonuses(): Record<CouncilAgentId, number> {
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

function normalizeSessionForChat(session: DiscussionSession): DiscussionSession {
  return {
    ...session,
    status: session.status === "running" ? "paused" : session.status,
    messages: session.messages.filter((message) => !message.isStreaming),
    runtime: {
      ...session.runtime,
      phase:
        session.status === "completed"
          ? "completed"
          : session.runtime.phase === "completed"
            ? "discussion"
            : session.runtime.phase,
    },
  };
}

/** Live stopwatch displayed while an AI agent is streaming a response. */
function LiveStopwatch({
  startTime,
  isStreaming,
  finalMs,
}: {
  startTime: number;
  isStreaming: boolean;
  finalMs?: number;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isStreaming) return;
    let raf: number;
    const tick = () => {
      setElapsed(Date.now() - startTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming, startTime]);

  const ms = isStreaming ? elapsed : (finalMs ?? 0);
  const seconds = (ms / 1000).toFixed(3);

  return <span className={`discord-stopwatch${isStreaming ? " is-ticking" : ""}`}>{seconds}s</span>;
}

const DiscordVirtuosoList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DiscordVirtuosoList({ className, ...props }, ref) {
    return <div {...props} ref={ref} className={`discord-messages ${className ?? ""}`} />;
  },
);

const TOOL_SYNTAX_LEAK_PATTERN = /\b(?:tool_use|tool_call|function_call|minimax:tool_call)\b/i;

function normalizeMessageText(raw: string) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getToolDisplayName(toolName: ToolCall["name"]): string {
  switch (toolName) {
    case "oracle.file_search":
      return "File Search";
    case "oracle.web_search":
    case "oracle.search":
      return "Web Search";
    case "oracle.verify":
      return "Verify";
    case "oracle.cite":
      return "Citations";
    default:
      return toolName;
  }
}

function summarizeToolCall(toolName: ToolCall["name"], args: Record<string, unknown>) {
  const json = JSON.stringify(args);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const claim = typeof args.claim === "string" ? args.claim.trim() : "";
  const topic = typeof args.topic === "string" ? args.topic.trim() : "";

  switch (toolName) {
    case "oracle.file_search":
      return `Searched attached files for "${query || json}"`;
    case "oracle.search":
    case "oracle.web_search":
      return `Searched the web for "${query || json}"`;
    case "oracle.verify":
      return `Verified claim: "${claim || json}"`;
    case "oracle.cite":
      return `Collected citations for "${topic || json}"`;
    default:
      return `${getToolDisplayName(toolName)} ${json}`;
  }
}

function createToolEvent(
  toolName: ToolCall["name"],
  args: Record<string, unknown>,
  output: string,
  error?: string,
): SessionToolEvent {
  return {
    id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    name: toolName,
    summary: summarizeToolCall(toolName, args),
    output,
    ...(error ? { error } : {}),
    timestamp: Date.now(),
  };
}

function buildDiscussionOpeningMessage(topic: string, attachmentSummary: string): string {
  return [
    topic.trim(),
    attachmentSummary ? `Attached: ${attachmentSummary.replace(/^Attachments:\s*/i, "")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function applyReactions(
  items: ChatMessage[],
  reactions: Array<{ targetId: string; emoji: ReactionId }>,
  actorId: CouncilAgentId,
) {
  if (reactions.length === 0) return items;

  return items.map((message) => {
    const matches = reactions.filter((reaction) => reaction.targetId === message.id);
    if (matches.length === 0) return message;

    const nextReactions = { ...(message.reactions ?? {}) } as Partial<
      Record<ReactionId, { count: number; by: string[] }>
    >;

    for (const reaction of matches) {
      const existing = nextReactions[reaction.emoji] ?? { count: 0, by: [] };
      if (!existing.by.includes(actorId)) {
        existing.by = [...existing.by, actorId];
        existing.count += 1;
      }
      nextReactions[reaction.emoji] = existing;
    }

    return { ...message, reactions: nextReactions };
  });
}

export function Chat({ session, onNavigate, onPersistSession }: ChatProps) {
  type SidePanelView = "default" | "logs" | "search" | "export";

  const normalizedSession = useMemo(() => normalizeSessionForChat(session), [session]);
  const topic = normalizedSession.topic;

  const [messages, setMessages] = useState<ChatMessage[]>(normalizedSession.messages);
  const [isRunning, setIsRunning] = useState(false);
  const [typingAgents, setTypingAgents] = useState<CouncilAgentId[]>([]);
  const [currentTurn, setCurrentTurn] = useState(normalizedSession.currentTurn);
  const [showBidding, setShowBidding] = useState(false);
  const [currentBidding, setCurrentBidding] = useState<BiddingRound | null>(null);
  const [totalTokens, setTotalTokens] = useState(normalizedSession.totalTokens);
  const [isPaused, setIsPaused] = useState(normalizedSession.status === "paused");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(normalizedSession.status);
  const [lastSavedAt, setLastSavedAt] = useState(normalizedSession.updatedAt);
  const pausedRef = useRef(normalizedSession.status === "paused");
  const [errors, setErrors] = useState<string[]>(normalizedSession.errors);
  const [sidePanelView, setSidePanelView] = useState<SidePanelView>("default");
  const [costState, setCostState] = useState<CostTracker | null>(null);
  const [moderatorUsage, setModeratorUsage] = useState<ModeratorUsageSnapshot>(
    normalizedSession.moderatorUsage,
  );
  const [attachmentPayloads, setAttachmentPayloads] = useState<Map<string, APIAttachment>>(
    new Map(),
  );
  const [attachmentsReady, setAttachmentsReady] = useState(
    normalizedSession.attachments.length === 0,
  );
  const [conflictState, setConflictState] = useState<ConflictDetection | null>(null);
  const [allConflicts, setAllConflicts] = useState<PairwiseConflict[]>([]);
  const [duoLogue, setDuoLogue] = useState<DuoLogueState | null>(normalizedSession.duoLogue);
  const [reactionPickerTarget, setReactionPickerTarget] = useState<string | null>(null);
  const [recentlyCopiedQuote, setRecentlyCopiedQuote] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [isTopicExpanded, setIsTopicExpanded] = useState(false);
  const [topicOverflowing, setTopicOverflowing] = useState(false);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const topicBodyRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const abortRef = useRef(false);
  const activeRequestsRef = useRef<Map<CouncilAgentId, AbortController>>(new Map());
  const moderatorAbortRef = useRef<AbortController | null>(null);
  const costTrackerRef = useRef<CostTrackerEngine | null>(null);
  const conflictDetectorRef = useRef(new ConflictDetector(60, 12));
  const memoryManagerRef = useRef<ConversationMemoryManager | null>(null);
  const hasStartedRef = useRef(
    normalizedSession.status !== "draft" ||
      normalizedSession.messages.length > 0 ||
      normalizedSession.currentTurn > 0,
  );
  const fairnessManagerRef = useRef(new FairnessManager());
  const whisperBonusesRef = useRef<Record<CouncilAgentId, number>>({
    ...createWhisperBonuses(),
    ...normalizedSession.runtime.whisperBonuses,
  });
  const cyclePendingRef = useRef<CouncilAgentId[]>(normalizedSession.runtime.cyclePending);
  const recentSpeakersRef = useRef<CouncilAgentId[]>(normalizedSession.runtime.recentSpeakers);
  const lastWhisperKeyRef = useRef<string | null>(normalizedSession.runtime.lastWhisperKey);
  const lastModeratorKeyRef = useRef<string | null>(normalizedSession.runtime.lastModeratorKey);
  const lastModeratorBalanceKeyRef = useRef<string | null>(
    normalizedSession.runtime.lastModeratorBalanceKey,
  );
  const lastModeratorSynthesisTurnRef = useRef(
    normalizedSession.runtime.lastModeratorSynthesisTurn,
  );
  const moderatorResolutionPromptPostedRef = useRef(
    normalizedSession.runtime.moderatorResolutionPromptPosted,
  );
  const moderatorFinalSummaryPostedRef = useRef(
    normalizedSession.runtime.moderatorFinalSummaryPosted,
  );
  const moderatorInFlightRef = useRef(false);
  const duoLogueRef = useRef<DuoLogueState | null>(normalizedSession.duoLogue);
  const messagesRef = useRef<ChatMessage[]>(normalizedSession.messages);
  const currentTurnRef = useRef(normalizedSession.currentTurn);
  const previousSpeakerRef = useRef<CouncilAgentId | null>(
    normalizedSession.runtime.previousSpeaker,
  );
  const phaseRef = useRef<SessionPhase>(normalizedSession.runtime.phase);
  const resolutionQueueRef = useRef<CouncilAgentId[]>(normalizedSession.runtime.resolutionQueue);
  const resolutionNoticePostedRef = useRef(normalizedSession.runtime.resolutionNoticePosted);
  const lastPersistSignatureRef = useRef("");

  const { config, getMaxTurns, getConfiguredProviders } = useConfig();
  const maxTurns = getMaxTurns();
  const configuredProviders = getConfiguredProviders();
  const configuredAgentIds = useMemo(
    () => AGENT_IDS.filter((id) => configuredProviders.includes(AGENT_CONFIG[id].provider)),
    [configuredProviders],
  );
  const configRef = useRef(config);
  configRef.current = config;
  const virtuosoComponents = useMemo(() => ({ List: DiscordVirtuosoList }), []);

  useEffect(() => {
    let cancelled = false;

    if (normalizedSession.attachments.length === 0) {
      setAttachmentPayloads(new Map());
      setAttachmentsReady(true);
      return () => {
        cancelled = true;
      };
    }

    setAttachmentsReady(false);
    void loadSessionAttachmentBlobs(normalizedSession.attachments)
      .then(async (loaded) => {
        const next = new Map<string, APIAttachment>();
        for (const [attachmentId, record] of loaded.entries()) {
          if (record.attachment.kind !== "image" && record.attachment.kind !== "pdf") {
            continue;
          }
          next.set(attachmentId, {
            id: record.attachment.id,
            kind: record.attachment.kind,
            name: record.attachment.name,
            mimeType: record.attachment.mimeType,
            data: await blobToBase64(record.blob),
          });
        }

        if (cancelled) return;
        setAttachmentPayloads(next);
        setAttachmentsReady(true);
      })
      .catch((error) => {
        apiLogger.log("warn", "attachments", "Failed to load session attachments", { error });
        if (cancelled) return;
        setAttachmentPayloads(new Map());
        setAttachmentsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedSession.attachments]);

  const messageIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < messages.length; i += 1) {
      map.set(messages[i]!.id, i);
    }
    return map;
  }, [messages]);

  const messageById = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const message of messages) {
      map.set(message.id, message);
    }
    return map;
  }, [messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId]);

  useEffect(() => {
    setIsTopicExpanded(false);
  }, [topic]);

  useEffect(() => {
    const node = topicBodyRef.current;
    if (!node) return;

    const measure = () => {
      const tolerance = 2;
      setTopicOverflowing(node.scrollHeight > node.clientHeight + tolerance);
    };

    measure();
    window.addEventListener("resize", measure);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => measure());
      observer.observe(node);
    }

    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [topic, isTopicExpanded]);

  const getAgentLabel = useCallback((agentId: string) => {
    const agent = (AGENT_CONFIG as Record<string, { name: string }>)[agentId];
    return agent?.name ?? agentId;
  }, []);

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const index = messageIndexById.get(messageId);
      if (index === undefined) return;
      virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
      setHighlightedMessageId(messageId);
    },
    [messageIndexById],
  );

  useEffect(() => {
    duoLogueRef.current = duoLogue;
  }, [duoLogue]);

  const resetRuntimeState = useCallback(() => {
    costTrackerRef.current = new CostTrackerEngine(AGENT_IDS);
    setCostState(costTrackerRef.current.getState());
    memoryManagerRef.current = createMemoryManager({ windowSize: MAX_CONTEXT_MESSAGES });
    memoryManagerRef.current.setTopic(topic);
    setTotalTokens({ input: 0, output: 0 });
    setModeratorUsage(DEFAULT_MODERATOR_USAGE);
    currentTurnRef.current = 0;
    setCurrentTurn(0);
    setCurrentBidding(null);
    setShowBidding(false);
    setErrors([]);
    setConflictState(null);
    setAllConflicts([]);
    setDuoLogue(null);
    setTypingAgents([]);
    previousSpeakerRef.current = null;
    phaseRef.current = "discussion";
    resolutionQueueRef.current = [];
    resolutionNoticePostedRef.current = false;
    duoLogueRef.current = null;
    lastWhisperKeyRef.current = null;
    lastModeratorKeyRef.current = null;
    lastModeratorBalanceKeyRef.current = null;
    lastModeratorSynthesisTurnRef.current = 0;
    moderatorResolutionPromptPostedRef.current = false;
    moderatorFinalSummaryPostedRef.current = false;
    fairnessManagerRef.current = new FairnessManager();
    whisperBonusesRef.current = createWhisperBonuses();
    cyclePendingRef.current = [];
    recentSpeakersRef.current = [];
  }, [topic]);

  const hydrateRuntimeState = useCallback((source: DiscussionSession) => {
    costTrackerRef.current = new CostTrackerEngine(AGENT_IDS);
    memoryManagerRef.current = createMemoryManager({ windowSize: MAX_CONTEXT_MESSAGES });
    memoryManagerRef.current.setTopic(source.topic);

    const effectiveRecentSpeakers =
      source.runtime.recentSpeakers.length > 0
        ? source.runtime.recentSpeakers
        : source.messages
            .filter((message): message is ChatMessage & { agentId: CouncilAgentId } =>
              isCouncilAgent(message.agentId),
            )
            .map((message) => message.agentId)
            .slice(-fairnessManagerRef.current.getWindowSize());

    fairnessManagerRef.current = new FairnessManager();
    for (const speaker of effectiveRecentSpeakers) {
      fairnessManagerRef.current.recordSpeaker(speaker);
    }

    const nextModeratorUsage: ModeratorUsageSnapshot = {
      ...DEFAULT_MODERATOR_USAGE,
    };

    for (const message of source.messages) {
      if (isCouncilAgent(message.agentId)) {
        if (message.tokens && message.metadata?.model) {
          costTrackerRef.current.recordUsage(
            message.agentId,
            message.tokens,
            message.metadata.model,
          );
        }

        memoryManagerRef.current.addMessage(message);

        for (const quoteId of message.quotedMessageIds ?? []) {
          memoryManagerRef.current.recordQuote(quoteId, message.agentId);
        }

        for (const [reactionId, reaction] of Object.entries(message.reactions ?? {})) {
          if (!reaction) continue;
          for (const actorId of reaction.by) {
            if (isCouncilAgent(actorId)) {
              memoryManagerRef.current.recordReaction(message.id, actorId, reactionId);
            }
          }
        }

        continue;
      }

      if (isModeratorMessage(message)) {
        memoryManagerRef.current.addMessage(message);

        if (message.tokens) {
          const moderatorCost = calculateMessageCost(message.metadata?.model, message.tokens);
          nextModeratorUsage.inputTokens += message.tokens.input;
          nextModeratorUsage.outputTokens += message.tokens.output;
          nextModeratorUsage.reasoningTokens += message.tokens.reasoning ?? 0;
          nextModeratorUsage.estimatedUSD += moderatorCost ?? 0;
          nextModeratorUsage.pricingAvailable =
            nextModeratorUsage.pricingAvailable || moderatorCost != null;
        }
      }
    }

    setCostState(costTrackerRef.current.getState());
    setModeratorUsage(nextModeratorUsage);
  }, []);

  useEffect(() => {
    hydrateRuntimeState(normalizedSession);
  }, [hydrateRuntimeState, normalizedSession]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  useEffect(() => {
    const agentMessages = messages.filter((m) => isCouncilAgent(m.agentId) && !m.isStreaming);

    if (agentMessages.length < 2) {
      setConflictState(null);
      setAllConflicts([]);
      return;
    }

    const { pairs, strongestPair: conflict } = conflictDetectorRef.current.evaluateAll(
      agentMessages,
      AGENT_IDS,
    );
    setAllConflicts(pairs);
    setConflictState(conflict);

    if (phaseRef.current === "discussion" && conflict && !duoLogueRef.current) {
      const newDuo: DuoLogueState = {
        participants: conflict.agentPair,
        remainingTurns: 3,
      };
      setDuoLogue(newDuo);
      duoLogueRef.current = newDuo;
    }
  }, [messages]);

  useEffect(() => {
    if (phaseRef.current !== "discussion") return;
    if (!conflictState) return;

    const key = conflictState.agentPair.join("-");
    if (lastWhisperKeyRef.current === key) return;
    lastWhisperKeyRef.current = key;

    const [from, to] = conflictState.agentPair;
    const whisper: WhisperMessage = {
      id: `whisper_${Date.now()}`,
      from,
      to,
      type: "strategy",
      payload: {
        proposedAction: "Press the counterpoint and tighten the argument.",
        bidBonus: 8,
      },
      timestamp: Date.now(),
    };

    whisperBonusesRef.current[to] = Math.min(
      20,
      (whisperBonusesRef.current[to] ?? 0) + (whisper.payload.bidBonus ?? 0),
    );
  }, [conflictState]);

  // Generate bidding scores based on conversation context
  const generateBiddingScores = useCallback(
    (
      excludeAgent?: CouncilAgentId,
      eligibleAgents: CouncilAgentId[] = AGENT_IDS,
      focusAgents?: CouncilAgentId[],
      cyclePending: CouncilAgentId[] = [],
    ): BiddingRound => {
      const scores = {
        george: 0,
        cathy: 0,
        grace: 0,
        douglas: 0,
        kate: 0,
        quinn: 0,
        mary: 0,
      } as Record<CouncilAgentId, number>;
      let maxScore = -Infinity;
      let winner: CouncilAgentId = eligibleAgents[0] ?? AGENT_IDS[0];
      let hasWinner = false;

      const fairnessAdjustments = fairnessManagerRef.current.calculateAdjustments(eligibleAgents);
      const fairnessById = new Map(fairnessAdjustments.map((a) => [a.agentId, a]));
      const pendingSet = new Set(cyclePending);

      // Only include agents that have API keys configured
      for (const agentId of eligibleAgents) {
        if (agentId === excludeAgent) continue;

        const agentConfig = AGENT_CONFIG[agentId];
        const hasApiKey = configuredProviders.includes(agentConfig.provider);

        if (!hasApiKey) {
          scores[agentId] = 0;
          continue;
        }

        // Generate score based on various factors
        const baseScore = 50 + Math.random() * 30;
        const whisperBonus = whisperBonusesRef.current[agentId] ?? 0;

        // Add engagement debt bonus (agents with pending debts get priority)
        // Capped at 20 to prevent feedback loops
        let engagementDebtBonus = 0;
        if (memoryManagerRef.current) {
          const debts = memoryManagerRef.current.getEngagementDebts(agentId);
          for (const debt of debts.slice(0, 3)) {
            engagementDebtBonus += Math.min(debt.priority * 0.2, 15);
          }
          engagementDebtBonus = Math.min(engagementDebtBonus, 20);
        }

        // Fairness adjustment to ensure balanced turn-taking
        const fairnessBonus = fairnessById.get(agentId)?.adjustment ?? 0;

        // Conflict focus bonus nudges disagreeing pair to respond without locking out others
        const conflictFocusBonus = focusAgents?.includes(agentId) ? 8 : 0;
        // Round-robin cycle bonus enforces "everyone speaks once per cycle" while retaining bidding.
        const cycleBonus = pendingSet.size === 0 ? 0 : pendingSet.has(agentId) ? 16 : -120;

        const score =
          baseScore +
          whisperBonus +
          engagementDebtBonus +
          fairnessBonus +
          conflictFocusBonus +
          cycleBonus;

        if (whisperBonus) {
          whisperBonusesRef.current[agentId] = 0;
        }

        scores[agentId] = score;
        if (score > maxScore) {
          maxScore = score;
          winner = agentId;
          hasWinner = true;
        }
      }

      // If no winner found (no API keys), pick first available
      if (!hasWinner) {
        const available = eligibleAgents.filter(
          (id) => id !== excludeAgent && configuredProviders.includes(AGENT_CONFIG[id].provider),
        );
        winner = available[0] || eligibleAgents[0] || AGENT_IDS[0];
      }

      return { scores, winner };
    },
    [configuredProviders],
  );

  const getContextMessages = useCallback(
    (agentId: CouncilAgentId) => {
      if (memoryManagerRef.current) {
        const context = memoryManagerRef.current.buildContext(agentId);
        const recent = context.recentMessages
          .filter((m) => isCouncilAgent(m.agentId) || isModeratorMessage(m))
          .slice(-MAX_CONTEXT_MESSAGES);
        return { messages: recent, engagementDebts: context.engagementDebt };
      }

      const fallback = messages
        .filter(
          (m) =>
            (isCouncilAgent(m.agentId) || isModeratorMessage(m)) &&
            m.content &&
            m.content.trim() !== "" &&
            !m.content.includes("[No response received]") &&
            !m.content.includes("No responses recorded") &&
            !m.error &&
            !m.isStreaming,
        )
        .slice(-MAX_CONTEXT_MESSAGES);

      return { messages: fallback, engagementDebts: [] };
    },
    [messages],
  );

  const buildEngagementPrompt = useCallback(
    (debts: Array<{ messageId: string; creditor: CouncilAgentId; reason: string }>) => {
      if (debts.length === 0) return "";
      const top = debts.slice(0, 2);
      const lines = top.map((debt) => {
        const name = AGENT_CONFIG[debt.creditor]?.name ?? debt.creditor;
        return `Respond to ${name} (id: ${debt.messageId}) because they ${debt.reason.replace(/_/g, " ")}.`;
      });
      return `Required replies: ${lines.join(" ")}`;
    },
    [],
  );

  const buildAttachmentContext = useCallback(
    (provider: Provider, model: string | undefined) => {
      const rawAttachments: APIAttachment[] = [];
      const fallbackBlocks: string[] = [];

      for (const attachment of normalizedSession.attachments) {
        const mode = model ? getAttachmentTransportMode(provider, model, attachment) : "fallback";
        const payload = attachmentPayloads.get(attachment.id);

        if (
          mode === "raw" &&
          payload &&
          (attachment.kind === "image" || attachment.kind === "pdf")
        ) {
          rawAttachments.push(payload);
          continue;
        }

        fallbackBlocks.push(attachment.fallbackText);
      }

      const notes: string[] = [];
      if (normalizedSession.attachments.length > 0) {
        notes.push(
          'If you need exact wording, page references, or code from attached files, call @tool(oracle.file_search, {"query":"..."}).',
        );
      }
      if (rawAttachments.length > 0) {
        const names = rawAttachments.map((attachment) => attachment.name).join(", ");
        notes.push(
          `Attached source material: ${names}. Use the attached files directly when relevant.`,
        );
      }
      if (fallbackBlocks.length > 0) {
        notes.push(`Attachment notes:\n${fallbackBlocks.join("\n\n")}`);
      }

      return {
        rawAttachments,
        attachmentText: notes.join("\n\n").trim(),
      };
    },
    [attachmentPayloads, normalizedSession.attachments],
  );

  // Build conversation history for API call
  const buildConversationHistory = useCallback(
    (agentId: CouncilAgentId, extraContext: APIChatMessage[] = []): APIChatMessage[] => {
      const agentConfig = AGENT_CONFIG[agentId];
      const model = configRef.current.models[agentConfig.provider];
      const { rawAttachments, attachmentText } = buildAttachmentContext(
        agentConfig.provider,
        model,
      );
      const history: APIChatMessage[] = [
        {
          role: "system",
          content: agentConfig.systemPrompt,
        },
      ];

      history.push({
        role: "user",
        content: [`Discussion topic: "${topic}"`, attachmentText].filter(Boolean).join("\n\n"),
        ...(attachmentText ? { cacheControl: "ephemeral" as const } : {}),
        ...(rawAttachments.length > 0 ? { attachments: rawAttachments } : {}),
      });

      const { messages: contextMessages, engagementDebts } = getContextMessages(agentId);

      if (contextMessages.length === 0) {
        history.push({
          role: "user",
          content:
            "You're the first to speak. State your position directly. If you need outside evidence first, emit only the @tool(...) line and stop. Include @quote(MSG_ID) only after there are messages to quote.",
        });
        return history;
      }

      for (const msg of contextMessages) {
        if (isCouncilAgent(msg.agentId)) {
          if (msg.agentId === agentId) {
            history.push({ role: "assistant", content: msg.content });
          } else {
            const speaker = AGENT_CONFIG[msg.agentId] ?? AGENT_CONFIG.system;
            history.push({
              role: "user",
              content: `${speaker.name} (id: ${msg.id}): ${msg.content}`,
            });
          }
          continue;
        }

        if (isModeratorMessage(msg)) {
          history.push({
            role: "user",
            content: `Moderator (id: ${msg.id}): ${msg.content}`,
          });
        }
      }

      const engagementPrompt = buildEngagementPrompt(engagementDebts);
      if (engagementPrompt) {
        history.push({ role: "user", content: engagementPrompt });
      }

      if (extraContext.length > 0) {
        history.push(...extraContext);
      }

      history.push({
        role: "user",
        content:
          "Your turn. Get enough context first; if exact wording or evidence is uncertain, use tools before answering. If you need a tool, emit only the @tool(...) line and stop so the app can run it. Otherwise respond directly to one specific message above and either add one new point or narrow the group toward a decision.",
      });

      return history;
    },
    [buildAttachmentContext, buildEngagementPrompt, getContextMessages, topic],
  );

  const buildResolutionConversationHistory = useCallback(
    (agentId: CouncilAgentId, turnsCompleted: number): APIChatMessage[] => {
      const agentConfig = AGENT_CONFIG[agentId];
      const model = configRef.current.models[agentConfig.provider];
      const { rawAttachments, attachmentText } = buildAttachmentContext(
        agentConfig.provider,
        model,
      );
      const history: APIChatMessage[] = [
        {
          role: "system",
          content: agentConfig.systemPrompt,
        },
      ];

      history.push({
        role: "user",
        content: [`Discussion topic: "${topic}"`, attachmentText].filter(Boolean).join("\n\n"),
        ...(attachmentText ? { cacheControl: "ephemeral" as const } : {}),
        ...(rawAttachments.length > 0 ? { attachments: rawAttachments } : {}),
      });

      const contextMessages = messagesRef.current
        .filter(
          (message) =>
            (isCouncilAgent(message.agentId) || isModeratorMessage(message)) &&
            !message.isStreaming,
        )
        .filter((message) => (message.content ?? "").trim().length > 0)
        .slice(-MAX_CONTEXT_MESSAGES);

      for (const msg of contextMessages) {
        const speaker = isCouncilAgent(msg.agentId) ? AGENT_CONFIG[msg.agentId].name : "Moderator";
        if (msg.agentId === agentId) {
          history.push({ role: "assistant", content: msg.content });
        } else {
          history.push({
            role: "user",
            content: `${speaker}: ${msg.content}`,
          });
        }
      }

      history.push({
        role: "user",
        content: `The discussion phase has ended after ${turnsCompleted} turns. You are now in the resolution round.
- Write 2–4 sentences total.
- Help the council land one closing result instead of continuing open-ended debate.
- State the single recommendation or outcome you think the council should adopt.
- Give the strongest supporting reason in one clause.
- Give one explicit condition that would change your mind.
- If you disagree with the leading option, name the best alternative in one short clause.
- Do NOT ask any questions.
- Do NOT say goodbye.
- Do NOT include @quote(...), @react(...), or @tool(...).
- Do NOT introduce a brand-new topic.`,
      });

      return history;
    },
    [buildAttachmentContext, topic],
  );

  const resolveQuoteTargets = useCallback(
    (_agentId: CouncilAgentId, explicit: string[]): string[] => {
      return explicit;
    },
    [],
  );

  const buildToolRuntimeContext = useCallback(
    (agentId: CouncilAgentId, currentDraft = ""): ToolContext => {
      const recentContext = messagesRef.current
        .filter(
          (message) =>
            (isCouncilAgent(message.agentId) || isModeratorMessage(message)) &&
            !message.isStreaming &&
            (message.content ?? "").trim().length > 0,
        )
        .slice(-8)
        .map((message) => {
          const speaker = isCouncilAgent(message.agentId)
            ? AGENT_CONFIG[message.agentId].name
            : "Moderator";
          return `${speaker}: ${message.content}`;
        });

      if (currentDraft.trim()) {
        recentContext.push(`${AGENT_CONFIG[agentId].name} draft: ${currentDraft.trim()}`);
      }

      return {
        attachments: normalizedSession.attachments,
        sessionTopic: topic,
        recentContext: recentContext.join("\n"),
      };
    },
    [normalizedSession.attachments, topic],
  );

  const buildToolContextMessages = useCallback(
    (results: Array<{ name: string; output: string; error?: string }>) => {
      const messages = results.map((result) => ({
        role: "user" as const,
        content: `Tool result (${result.name}): ${result.error ? `Error: ${result.error}` : result.output}`,
      }));
      if (messages.length > 0) {
        messages.push({
          role: "user",
          content:
            "Use the tool results above to answer directly. Only call another tool if a critical passage is still incomplete or the evidence is still missing.",
        });
      }
      return messages;
    },
    [],
  );

  // Get model display name
  const getModelDisplayName = useCallback(
    (provider: Provider, overrideModel?: string): string => {
      const modelId = overrideModel || config.models[provider];
      if (!modelId) return "Unknown Model";
      return MODEL_DISPLAY_NAMES[modelId] || modelId;
    },
    [config.models],
  );

  /**
   * Get proxy configuration - unified for all providers
   * Returns the global proxy if configured, otherwise undefined (direct connection)
   */
  const getProxy = useCallback(() => {
    if (config.proxy.type !== "none" && config.proxy.host && config.proxy.port > 0) {
      return config.proxy;
    }
    return undefined;
  }, [config.proxy]);

  const pickModeratorRuntime = useCallback(() => {
    if (!config.preferences.moderatorEnabled) return null;
    const credential = config.credentials.openai;
    if (!credential?.apiKey) return null;
    // Moderator is fixed to GPT-5.3 Instant for lower-latency coordination messages.
    return { provider: "openai" as const, credential, model: "gpt-5.3-chat-latest" as const };
  }, [config.credentials.openai, config.preferences.moderatorEnabled]);

  const pickFinalSummaryRuntime = useCallback(() => {
    const openaiCredential = config.credentials.openai;
    if (openaiCredential?.apiKey) {
      return {
        provider: "openai" as const,
        credential: openaiCredential,
        model: "gpt-5.3-chat-latest" as const,
      };
    }

    for (const provider of [
      "anthropic",
      "google",
      "deepseek",
      "kimi",
      "qwen",
      "minimax",
    ] as const) {
      const credential = config.credentials[provider];
      const model = config.models[provider];
      if (!credential?.apiKey || !model) continue;
      return { provider, credential, model };
    }

    return null;
  }, [config.credentials, config.models]);

  const generateModeratorMessage = useCallback(
    async (options: {
      kind: "opening" | "tension" | "synthesis" | "balance" | "resolution_prompt" | "final_summary";
      conflict?: ConflictDetection | null;
      turn?: number;
      remainingTurns?: number;
    }): Promise<ChatMessage | null> => {
      if (abortRef.current) return null;
      if (options.kind !== "final_summary" && !config.preferences.moderatorEnabled) return null;
      if (moderatorInFlightRef.current) return null;

      const runtime =
        options.kind === "final_summary" ? pickFinalSummaryRuntime() : pickModeratorRuntime();
      if (!runtime) return null;

      const proxy = getProxy();
      const controller = new AbortController();
      moderatorAbortRef.current?.abort();
      moderatorAbortRef.current = controller;

      moderatorInFlightRef.current = true;

      const { provider, credential, model } = runtime;
      const newMessage: ChatMessage = {
        id: `msg_${Date.now()}_moderator_${Math.random().toString(36).slice(2, 7)}`,
        agentId: "system",
        displayName: "Moderator",
        displayProvider: provider,
        content: "",
        timestamp: Date.now(),
        isStreaming: true,
        metadata: { model: model as ModelId, latencyMs: 0 },
      };

      setMessages((prev) => [...prev, newMessage]);

      let streamingContent = "";
      let streamingThinking = "";
      try {
        const recentForContext =
          options.kind === "opening"
            ? []
            : messagesRef.current
                .filter(
                  (m) => (isCouncilAgent(m.agentId) || isModeratorMessage(m)) && !m.isStreaming,
                )
                .filter((m) => (m.content ?? "").trim().length > 0)
                .slice(-12);
        const { rawAttachments, attachmentText } = buildAttachmentContext(provider, model);

        const history: APIChatMessage[] = [
          { role: "system", content: MODERATOR_SYSTEM_PROMPT },
          {
            role: "user",
            content: [`Discussion topic: "${topic}"`, attachmentText].filter(Boolean).join("\n\n"),
            ...(attachmentText ? { cacheControl: "ephemeral" as const } : {}),
            ...(rawAttachments.length > 0 ? { attachments: rawAttachments } : {}),
          },
        ];

        for (const msg of recentForContext) {
          const speaker = isCouncilAgent(msg.agentId)
            ? AGENT_CONFIG[msg.agentId].name
            : "Moderator";
          history.push({
            role: "user",
            content: `${speaker} (id: ${msg.id}): ${msg.content}`,
          });
        }

        if (options.kind === "opening") {
          history.push({
            role: "user",
            content:
              "Write the opening moderator message (1–2 sentences). Re-state the topic in plain language, set one measurable objective, and ask one concrete kickoff question.",
          });
        } else if (options.kind === "tension") {
          const conflict = options.conflict;
          const a = conflict?.agentPair?.[0];
          const b = conflict?.agentPair?.[1];
          const pct = conflict ? Math.round((conflict.conflictScore / 100) * 100) : null;
          const pairText =
            a && b
              ? `${AGENT_CONFIG[a]?.name ?? a} ↔ ${AGENT_CONFIG[b]?.name ?? b}${pct != null ? ` (${pct}%)` : ""}`
              : "a pair of agents";
          history.push({
            role: "user",
            content: `Tension detected between ${pairText}. Write a short moderator note (1–2 sentences):
- Name the core disagreement in one clause.
- Ask ONE clarifying question aimed at the pair.
- Optionally invite a quieter agent by name to weigh in with ONE sentence.
- Keep it calm and concrete.`,
          });
        } else if (options.kind === "synthesis") {
          history.push({
            role: "user",
            content: `Provide a short synthesis for turn ${options.turn ?? "current"}:
- One clause: what the group currently agrees on.
- One clause: the sharpest unresolved disagreement.
- Ask exactly one question that can move the discussion toward evidence or decision criteria.`,
          });
        } else if (options.kind === "balance") {
          history.push({
            role: "user",
            content: `Participation seems concentrated in a few voices.
Write a brief intervention that:
- names this pattern neutrally,
- invites one quieter agent by name,
- asks one concrete question that advances the topic.`,
          });
        } else if (options.kind === "resolution_prompt") {
          history.push({
            role: "user",
            content: `The discussion is near the end (remaining turns: ${options.remainingTurns ?? "few"}).
Write a concise moderator note that moves the council into resolution:
- tell them the next step is to converge on one closing result,
- instruct each agent to state their preferred recommendation and one condition that would change their mind,
- do not leave the room with another open-ended question.`,
          });
        } else {
          history.push({
            role: "user",
            content: `The resolution round is complete after ${options.turn ?? "the discussion"} turns.
Write the official closing summary in 3–4 short sentences:
- The first sentence must start with exactly one of these labels: Consensus:, Majority with dissent:, or Unresolved:.
- State the council's final recommendation or the blocking issue in plain language.
- Name the main dissent or uncertainty in one short clause.
- End with the next action, test, or evidence that matters most.
- Do NOT ask a question.`,
          });
        }

        const result = await callProvider(
          provider,
          credential,
          model,
          history,
          (chunk) => {
            if (abortRef.current) return;
            if (chunk.content) {
              streamingContent += chunk.content;
            }
            if (chunk.thinking) {
              streamingThinking += chunk.thinking;
            }
            if (chunk.content || chunk.thinking) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === newMessage.id
                    ? { ...m, content: streamingContent, thinking: streamingThinking }
                    : m,
                ),
              );
            }
          },
          proxy,
          {
            signal: controller.signal,
            idleTimeoutMs: 60000,
            requestTimeoutMs: 90000,
          },
        );

        if (abortRef.current) {
          setMessages((prev) => prev.filter((m) => m.id !== newMessage.id));
          return null;
        }

        const { cleaned } = extractActions(result.content || "", REACTION_IDS);
        const displayContent =
          cleaned || normalizeMessageText(result.content || streamingContent || "");

        const finalMessage: ChatMessage = {
          ...newMessage,
          content: displayContent || "[No response received]",
          isStreaming: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          error: result.error,
          thinking: result.thinking || streamingThinking || undefined,
          fullResponse: displayContent || undefined,
          metadata: {
            model: model as ModelId,
            latencyMs: result.latencyMs,
          },
        };

        setMessages((prev) => prev.map((m) => (m.id === newMessage.id ? finalMessage : m)));

        if (memoryManagerRef.current && result.success) {
          memoryManagerRef.current.addMessage(finalMessage);
        }

        if (result.success) {
          setTotalTokens((prev) => ({
            input: prev.input + result.tokens.input,
            output: prev.output + result.tokens.output,
          }));

          const moderatorCost = calculateMessageCost(model, result.tokens);
          setModeratorUsage((prev) => ({
            inputTokens: prev.inputTokens + result.tokens.input,
            outputTokens: prev.outputTokens + result.tokens.output,
            reasoningTokens: prev.reasoningTokens + (result.tokens.reasoning ?? 0),
            estimatedUSD: prev.estimatedUSD + (moderatorCost ?? 0),
            pricingAvailable: prev.pricingAvailable || moderatorCost != null,
          }));
        }

        return finalMessage;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id
              ? {
                  ...m,
                  isStreaming: false,
                  error: errorMessage,
                  content: streamingContent || "[Moderator failed]",
                  thinking: streamingThinking || undefined,
                  metadata: {
                    model: model as ModelId,
                    latencyMs: Date.now() - newMessage.timestamp,
                  },
                }
              : m,
          ),
        );
        return null;
      } finally {
        moderatorInFlightRef.current = false;
        moderatorAbortRef.current = null;
      }
    },
    [
      buildAttachmentContext,
      config.preferences.moderatorEnabled,
      getProxy,
      pickFinalSummaryRuntime,
      pickModeratorRuntime,
      topic,
    ],
  );

  useEffect(() => {
    if (!isRunning) return;
    if (phaseRef.current !== "discussion") return;
    if (!config.preferences.moderatorEnabled) return;
    if (!conflictState) return;

    const key = conflictState.agentPair.join("-");
    if (lastModeratorKeyRef.current === key) return;
    lastModeratorKeyRef.current = key;

    void generateModeratorMessage({ kind: "tension", conflict: conflictState });
  }, [config.preferences.moderatorEnabled, conflictState, generateModeratorMessage, isRunning]);

  const toggleUserReaction = useCallback((targetId: string, emoji: ReactionId) => {
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== targetId) return message;

        const existingBar = (message.reactions ?? {}) as Partial<
          Record<ReactionId, { count: number; by: string[] }>
        >;
        const nextBar = { ...existingBar };

        const existing = nextBar[emoji] ?? { count: 0, by: [] };
        const alreadyReacted = existing.by.includes("user");

        if (alreadyReacted) {
          const nextBy = existing.by.filter((id) => id !== "user");
          const nextCount = Math.max(0, existing.count - 1);
          if (nextCount === 0) {
            delete nextBar[emoji];
          } else {
            nextBar[emoji] = { count: nextCount, by: nextBy };
          }
        } else {
          nextBar[emoji] = { count: existing.count + 1, by: [...existing.by, "user"] };
        }

        return { ...message, reactions: nextBar };
      }),
    );
  }, []);

  const copyQuoteToken = useCallback(async (messageId: string) => {
    const token = `@quote(${messageId})`;

    try {
      await navigator.clipboard.writeText(token);
      setRecentlyCopiedQuote(messageId);
      window.setTimeout(
        () => setRecentlyCopiedQuote((prev) => (prev === messageId ? null : prev)),
        900,
      );
    } catch (error) {
      apiLogger.log("warn", "ui", "Clipboard copy failed", { error });
    }
  }, []);

  // Generate agent response using real API
  const generateAgentResponse = useCallback(
    async (agentId: CouncilAgentId): Promise<ChatMessage | null> => {
      if (abortRef.current) return null;

      const currentConfig = configRef.current;
      const agentConfig = AGENT_CONFIG[agentId];
      const credential = currentConfig.credentials[agentConfig.provider];
      const model = currentConfig.models[agentConfig.provider];

      if (!credential?.apiKey) {
        const providerName =
          agentConfig.provider === "kimi" ? "Kimi" : PROVIDER_INFO[agentConfig.provider].name;
        const errorMsg = `No API key configured for ${providerName}`;
        apiLogger.log("error", agentConfig.provider, errorMsg);
        setErrors((prev) => [...prev, errorMsg]);
        return null;
      }

      if (!model) {
        const errorMsg = `No model configured for ${agentConfig.provider}`;
        apiLogger.log("error", agentConfig.provider, errorMsg);
        setErrors((prev) => [...prev, errorMsg]);
        return null;
      }

      setTypingAgents((prev) => (prev.includes(agentId) ? prev : [...prev, agentId]));

      // Create new message with streaming flag
      const newMessage: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        agentId,
        content: "",
        timestamp: Date.now(),
        isStreaming: true,
        metadata: { model: model as ModelId, latencyMs: 0 },
      };

      setMessages((prev) => [...prev, newMessage]);

      const idleTimeoutMs = 120000;
      const requestTimeoutMs =
        agentConfig.provider === "google" || agentConfig.provider === "openai" ? 240000 : 180000;
      const proxy = getProxy();

      const setActiveController = (controller: AbortController | null) => {
        if (controller) {
          activeRequestsRef.current.set(agentId, controller);
        } else {
          activeRequestsRef.current.delete(agentId);
        }
      };

      apiLogger.log("info", agentConfig.provider, "Dispatching request", {
        model,
        proxy: proxy?.type ?? "none (direct)",
        requestTimeoutMs,
        idleTimeoutMs,
      });

      let streamingContent = "";
      let streamingThinking = "";
      let toolEvents: SessionToolEvent[] = [];
      let lastStreamFlushAt = 0;
      let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const clearStreamFlushTimer = () => {
        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
      };
      const flushStreamingMessage = (force = false) => {
        if (abortRef.current) return;
        const now = Date.now();
        if (!force && now - lastStreamFlushAt < 50) return;
        lastStreamFlushAt = now;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMessage.id
              ? {
                  ...m,
                  content: streamingContent,
                  thinking: streamingThinking || undefined,
                  toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
                }
              : m,
          ),
        );
      };
      const scheduleStreamFlush = () => {
        if (streamFlushTimer) return;
        streamFlushTimer = setTimeout(() => {
          streamFlushTimer = null;
          flushStreamingMessage(true);
        }, 60);
      };

      try {
        let modelUsed = model;
        let toolIteration = 0;

        const appendToolEvents = (events: SessionToolEvent[]) => {
          toolEvents = [...toolEvents, ...events];
          setMessages((prev) =>
            prev.map((m) => (m.id === newMessage.id ? { ...m, toolEvents } : m)),
          );
        };

        const runCompletion = async (
          history: APIChatMessage[],
          currentModel: string,
          requestOptions?: { disableThinking?: boolean },
        ) => {
          const requestController = new AbortController();
          setActiveController(requestController);
          const streamingToolDetector = createStreamingToolCallDetector();
          const streamedToolCalls: ToolCall[] = [];
          let interruptedForTools = false;

          streamingContent = "";
          streamingThinking = "";
          lastStreamFlushAt = 0;
          clearStreamFlushTimer();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === newMessage.id ? { ...m, content: "", thinking: undefined, toolEvents } : m,
            ),
          );

          const providerResult = await callProvider(
            agentConfig.provider,
            credential,
            currentModel,
            history,
            (chunk) => {
              if (abortRef.current) return;
              if (chunk.content) {
                const detection = streamingToolDetector.push(chunk.content);
                streamingContent = detection.visibleText;
                if (detection.toolCalls.length > 0) {
                  streamedToolCalls.push(...detection.toolCalls);
                  interruptedForTools = true;
                  clearStreamFlushTimer();
                  flushStreamingMessage(true);
                  requestController.abort();
                  return;
                }
              }
              if (chunk.thinking) {
                streamingThinking += chunk.thinking;
              }
              if (chunk.done) {
                if (!interruptedForTools) {
                  streamingContent = streamingToolDetector.finish();
                }
                clearStreamFlushTimer();
                flushStreamingMessage(true);
                return;
              }
              if (Date.now() - lastStreamFlushAt >= 50) {
                flushStreamingMessage(true);
              } else {
                scheduleStreamFlush();
              }
            },
            proxy,
            {
              idleTimeoutMs,
              requestTimeoutMs,
              signal: requestController.signal,
              disableThinking: requestOptions?.disableThinking,
            },
          );

          const parsedVisible = interruptedForTools
            ? normalizeMessageText(streamingToolDetector.getVisibleText())
            : extractActions(providerResult.content || "", REACTION_IDS).cleaned;
          const visibleContent =
            parsedVisible || streamingContent || normalizeMessageText(providerResult.content || "");

          streamingContent = visibleContent;
          clearStreamFlushTimer();
          flushStreamingMessage(true);

          return {
            ...providerResult,
            content: visibleContent,
            rawContent: providerResult.content || "",
            success: interruptedForTools ? true : providerResult.success,
            error: interruptedForTools ? undefined : providerResult.error,
            timedOut: interruptedForTools ? false : providerResult.timedOut,
            streamedToolCalls,
            interruptedForTools,
          };
        };

        let history = buildConversationHistory(agentId);
        let result = await runCompletion(history, modelUsed);

        if (!result.success && agentConfig.provider === "anthropic" && model.includes("opus")) {
          // If the full dated model ID fails, try the alias as fallback
          const fallbackModel = "claude-opus-4-6";
          if (modelUsed !== fallbackModel) {
            apiLogger.log("warn", "anthropic", "Primary model failed; retrying with fallback", {
              primary: model,
              fallback: fallbackModel,
            });
            modelUsed = fallbackModel;
            result = await runCompletion(history, modelUsed);
          }
        }

        while (result.success && toolIteration < MAX_TOOL_ITERATIONS) {
          const parsedForTools = extractActions(
            result.rawContent || result.content || "",
            REACTION_IDS,
          );
          const toolCalls =
            result.streamedToolCalls.length > 0
              ? result.streamedToolCalls
              : parsedForTools.toolCalls;
          if (toolCalls.length === 0) break;

          const interim =
            result.content ||
            parsedForTools.cleaned ||
            (toolIteration === 0 ? "Researching sources..." : "Gathering more context...");
          setMessages((prev) =>
            prev.map((m) => (m.id === newMessage.id ? { ...m, content: interim, toolEvents } : m)),
          );

          const calls = toolCalls.slice(0, 3);
          const results = await Promise.all(
            calls.map((call) => runToolCall(call, buildToolRuntimeContext(agentId, interim))),
          );
          appendToolEvents(
            results.map((toolResult, index) =>
              createToolEvent(
                toolResult.name,
                calls[index]?.args ?? {},
                toolResult.output,
                toolResult.error,
              ),
            ),
          );

          const extraContext = buildToolContextMessages(results);
          history = buildConversationHistory(agentId, extraContext);
          result = await runCompletion(history, modelUsed);
          toolIteration += 1;
        }

        let parsed = extractActions(result.rawContent || result.content || "", REACTION_IDS);

        if (
          result.success &&
          TOOL_SYNTAX_LEAK_PATTERN.test(result.rawContent || "") &&
          parsed.toolCalls.length === 0
        ) {
          history = [
            ...history,
            {
              role: "user",
              content:
                'Do not output tool_use, tool_call, function_call, XML, or provider-specific tool syntax. If you need a tool, use exactly @tool(name, {"query":"..."}) on its own line. Otherwise answer directly now.',
            },
          ];
          result = await runCompletion(history, modelUsed, {
            disableThinking: agentConfig.provider === "anthropic",
          });
          parsed = extractActions(result.rawContent || result.content || "", REACTION_IDS);
        }

        if (
          result.success &&
          !normalizeMessageText(result.content || "") &&
          normalizeMessageText(result.thinking || streamingThinking || "")
        ) {
          history = [
            ...history,
            {
              role: "user",
              content:
                "You produced internal reasoning but no visible answer. Reply with the final answer now. Do not repeat the hidden reasoning, and do not stop at tool syntax.",
            },
          ];
          result = await runCompletion(history, modelUsed, {
            disableThinking: agentConfig.provider === "anthropic",
          });
          parsed = extractActions(result.rawContent || result.content || "", REACTION_IDS);
        }

        if (
          result.success &&
          toolEvents.length > 0 &&
          !parsed.cleaned &&
          (parsed.toolCalls.length > 0 || !(result.content || "").trim())
        ) {
          history = [
            ...history,
            {
              role: "user",
              content:
                "You already have enough research context. Write the final answer now using the evidence above. Do not call another tool in this reply.",
            },
          ];
          result = await runCompletion(history, modelUsed, {
            disableThinking: agentConfig.provider === "anthropic",
          });
          parsed = extractActions(result.rawContent || result.content || "", REACTION_IDS);
        }

        if (abortRef.current) {
          setMessages((prev) => prev.filter((m) => m.id !== newMessage.id));
          return null;
        }

        const finalVisibleContent = normalizeMessageText(result.content || streamingContent || "");
        const resolvedQuotes = resolveQuoteTargets(agentId, parsed.quoteTargets);
        const parsedReactions = parsed.reactions.map((reaction) => ({
          targetId: reaction.targetId,
          emoji: reaction.emoji as ReactionId,
        }));
        const resolvedReactions =
          parsedReactions.length === 0 && resolvedQuotes.length > 0
            ? [{ targetId: resolvedQuotes[0]!, emoji: DEFAULT_REACTION }]
            : parsedReactions;
        const displayContent =
          finalVisibleContent ||
          parsed.cleaned ||
          (toolEvents.length > 0
            ? "Research completed, but no final answer was generated."
            : "[No response received]");

        const finalMessage: ChatMessage = {
          ...newMessage,
          content: displayContent,
          thinking: result.thinking || streamingThinking || undefined,
          fullResponse: displayContent || undefined,
          isStreaming: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          error: result.error,
          toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
          quotedMessageIds: resolvedQuotes.length > 0 ? resolvedQuotes : undefined,
          metadata: {
            model: modelUsed as ModelId,
            latencyMs: result.latencyMs,
          },
        };

        setMessages((prev) => {
          const updated = prev.map((m) => (m.id === newMessage.id ? finalMessage : m));
          return applyReactions(updated, resolvedReactions, agentId);
        });

        if (memoryManagerRef.current && result.success) {
          memoryManagerRef.current.addMessage(finalMessage);

          for (const quoteId of resolvedQuotes) {
            memoryManagerRef.current.recordQuote(quoteId, agentId);
          }

          for (const reaction of resolvedReactions) {
            memoryManagerRef.current.recordReaction(reaction.targetId, agentId, reaction.emoji);
          }
        }

        if (result.success) {
          setTotalTokens((prev) => ({
            input: prev.input + result.tokens.input,
            output: prev.output + result.tokens.output,
          }));

          if (costTrackerRef.current) {
            costTrackerRef.current.recordUsage(agentId, result.tokens, modelUsed);
            setCostState(costTrackerRef.current.getState());
          }
        } else {
          setErrors((prev) => [...prev, result.error || "Unknown error"]);
        }

        return finalMessage;
      } finally {
        clearStreamFlushTimer();
        setActiveController(null);
        setTypingAgents((prev) => prev.filter((id) => id !== agentId));
      }
    },
    [
      buildConversationHistory,
      buildToolRuntimeContext,
      buildToolContextMessages,
      getProxy,
      resolveQuoteTargets,
    ],
  );

  const generateResolutionResponse = useCallback(
    async (agentId: CouncilAgentId, turnsCompleted: number): Promise<ChatMessage | null> => {
      if (abortRef.current) return null;

      const agentConfig = AGENT_CONFIG[agentId];
      const credential = config.credentials[agentConfig.provider];
      const model = config.models[agentConfig.provider];

      if (!credential?.apiKey || !model) return null;

      const proxy = getProxy();
      const controller = new AbortController();
      activeRequestsRef.current.set(agentId, controller);
      setTypingAgents((prev) => (prev.includes(agentId) ? prev : [...prev, agentId]));

      const newMessage: ChatMessage = {
        id: `msg_${Date.now()}_${agentId}_resolution`,
        agentId,
        content: "",
        timestamp: Date.now(),
        isStreaming: true,
        metadata: { model: model as ModelId, latencyMs: 0 },
      };

      setMessages((prev) => [...prev, newMessage]);

      let streamingContent = "";
      let streamingThinking = "";
      try {
        const history = buildResolutionConversationHistory(agentId, turnsCompleted);
        const result = await callProvider(
          agentConfig.provider,
          credential,
          model,
          history,
          (chunk) => {
            if (abortRef.current) return;
            if (chunk.content) {
              streamingContent += chunk.content;
            }
            if (chunk.thinking) {
              streamingThinking += chunk.thinking;
            }
            if (chunk.content || chunk.thinking) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === newMessage.id
                    ? {
                        ...m,
                        content: streamingContent,
                        thinking: streamingThinking || undefined,
                      }
                    : m,
                ),
              );
            }
          },
          proxy,
          {
            signal: controller.signal,
            // Resolution notes should be quick; keep timeouts tight.
            idleTimeoutMs: 60000,
            requestTimeoutMs: 90000,
          },
        );

        if (abortRef.current) {
          setMessages((prev) => prev.filter((m) => m.id !== newMessage.id));
          return null;
        }

        const { cleaned } = extractActions(result.content || "", REACTION_IDS);
        const displayContent =
          cleaned || normalizeMessageText(result.content || streamingContent || "");

        const finalMessage: ChatMessage = {
          ...newMessage,
          content: displayContent || "[No response received]",
          thinking: result.thinking || streamingThinking || undefined,
          fullResponse: displayContent || undefined,
          isStreaming: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          error: result.error,
          metadata: {
            model: model as ModelId,
            latencyMs: result.latencyMs,
          },
        };

        setMessages((prev) => prev.map((m) => (m.id === newMessage.id ? finalMessage : m)));

        if (result.success) {
          if (memoryManagerRef.current) {
            memoryManagerRef.current.addMessage(finalMessage);
          }

          setTotalTokens((prev) => ({
            input: prev.input + result.tokens.input,
            output: prev.output + result.tokens.output,
          }));

          if (costTrackerRef.current) {
            costTrackerRef.current.recordUsage(agentId, result.tokens, model);
            setCostState(costTrackerRef.current.getState());
          }
        }

        return finalMessage;
      } finally {
        activeRequestsRef.current.delete(agentId);
        setTypingAgents((prev) => prev.filter((id) => id !== agentId));
      }
    },
    [buildResolutionConversationHistory, config, getProxy],
  );

  // Main discussion loop
  const runDiscussion = useCallback(
    async (mode: "fresh" | "resume" = "resume") => {
      if (mode === "fresh") {
        resetRuntimeState();

        const topicMessage: ChatMessage = {
          id: `msg_${Date.now()}`,
          agentId: "system",
          content: buildDiscussionOpeningMessage(
            topic,
            summarizeSessionAttachments(normalizedSession.attachments),
          ),
          timestamp: Date.now(),
        };

        setMessages([topicMessage]);
        cyclePendingRef.current = [...configuredAgentIds];
      } else {
        if (phaseRef.current === "completed") {
          return;
        }

        if (phaseRef.current === "discussion") {
          const pending = cyclePendingRef.current.filter((id) => configuredAgentIds.includes(id));
          cyclePendingRef.current = pending.length > 0 ? pending : [...configuredAgentIds];
        } else if (phaseRef.current === "resolution") {
          resolutionQueueRef.current = resolutionQueueRef.current.filter((id) =>
            configuredAgentIds.includes(id),
          );
        }
      }

      abortRef.current = false;
      pausedRef.current = false;
      setIsPaused(false);
      setIsRunning(true);
      setSessionStatus("running");
      setTypingAgents([]);

      if (mode === "fresh" && config.preferences.moderatorEnabled && !abortRef.current) {
        await generateModeratorMessage({ kind: "opening" });
      }

      while (
        !abortRef.current &&
        phaseRef.current === "discussion" &&
        (maxTurns === Infinity || currentTurnRef.current < maxTurns)
      ) {
        const pending = cyclePendingRef.current.filter((id) => configuredAgentIds.includes(id));
        cyclePendingRef.current = pending.length > 0 ? pending : [...configuredAgentIds];
        const pendingNow = cyclePendingRef.current;

        const focusAgents = duoLogueRef.current?.remainingTurns
          ? duoLogueRef.current.participants
          : undefined;
        const excludeForRound =
          pendingNow.length > 1 ? (previousSpeakerRef.current ?? undefined) : undefined;
        const bidding = generateBiddingScores(excludeForRound, AGENT_IDS, focusAgents, pendingNow);

        if (config.preferences.showBiddingScores) {
          setCurrentBidding(bidding);
          setShowBidding(true);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          setShowBidding(false);
        }

        if (abortRef.current) break;

        const rankedAgents = (Object.entries(bidding.scores) as [CouncilAgentId, number][])
          .filter(
            ([agentId, score]) =>
              score > 0 &&
              configuredProviders.includes(AGENT_CONFIG[agentId].provider) &&
              pendingNow.includes(agentId),
          )
          .sort((a, b) => b[1] - a[1])
          .map(([agentId]) => agentId);

        const selectedSpeaker = rankedAgents[0];
        if (!selectedSpeaker) {
          break;
        }

        let response = await generateAgentResponse(selectedSpeaker);
        if ((!response || response.error) && !abortRef.current) {
          response = await generateAgentResponse(selectedSpeaker);
        }
        if (abortRef.current) break;

        const actualSpeaker: CouncilAgentId | null =
          response && !response.error ? selectedSpeaker : null;

        cyclePendingRef.current = cyclePendingRef.current.filter((id) => id !== selectedSpeaker);
        if (actualSpeaker) {
          previousSpeakerRef.current = actualSpeaker;
          fairnessManagerRef.current.recordSpeaker(actualSpeaker);
          recentSpeakersRef.current = [...recentSpeakersRef.current.slice(-5), actualSpeaker];
        }

        currentTurnRef.current += 1;
        setCurrentTurn(currentTurnRef.current);

        if (duoLogueRef.current) {
          const remaining = duoLogueRef.current.remainingTurns - 1;
          if (remaining <= 0) {
            duoLogueRef.current = null;
            setDuoLogue(null);
            setConflictState(null);
          } else {
            const nextDuo = { ...duoLogueRef.current, remainingTurns: remaining };
            duoLogueRef.current = nextDuo;
            setDuoLogue(nextDuo);
          }
        }

        if (config.preferences.moderatorEnabled && !abortRef.current) {
          if (
            currentTurnRef.current > 0 &&
            currentTurnRef.current % 7 === 0 &&
            lastModeratorSynthesisTurnRef.current !== currentTurnRef.current
          ) {
            lastModeratorSynthesisTurnRef.current = currentTurnRef.current;
            await generateModeratorMessage({ kind: "synthesis", turn: currentTurnRef.current });
          }

          const recentSpeakers = recentSpeakersRef.current.slice(-6);
          const uniqueSpeakers = Array.from(new Set(recentSpeakers));
          if (recentSpeakers.length >= 6 && uniqueSpeakers.length <= 2) {
            const balanceKey = `${currentTurnRef.current}:${uniqueSpeakers.sort().join("-")}`;
            if (lastModeratorBalanceKeyRef.current !== balanceKey) {
              lastModeratorBalanceKeyRef.current = balanceKey;
              await generateModeratorMessage({ kind: "balance", turn: currentTurnRef.current });
            }
          }

          if (
            maxTurns !== Infinity &&
            !moderatorResolutionPromptPostedRef.current &&
            maxTurns - currentTurnRef.current <= 3
          ) {
            moderatorResolutionPromptPostedRef.current = true;
            await generateModeratorMessage({
              kind: "resolution_prompt",
              remainingTurns: maxTurns - currentTurnRef.current,
            });
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (!abortRef.current && phaseRef.current === "discussion" && currentTurnRef.current > 0) {
        phaseRef.current = "resolution";
        duoLogueRef.current = null;
        setDuoLogue(null);

        if (!resolutionNoticePostedRef.current) {
          const resolutionNotice: ChatMessage = {
            id: `msg_${Date.now()}_resolution_notice`,
            agentId: "system",
            content: `Discussion phase ended after ${currentTurnRef.current} turns. Resolution round: each agent states a final position, then the Moderator publishes the official result.`,
            timestamp: Date.now(),
          };
          resolutionNoticePostedRef.current = true;
          setMessages((prev) => [...prev, resolutionNotice]);
        }

        if (resolutionQueueRef.current.length === 0) {
          resolutionQueueRef.current = [...configuredAgentIds];
        }
      }

      while (
        !abortRef.current &&
        phaseRef.current === "resolution" &&
        resolutionQueueRef.current.length > 0
      ) {
        const nextAgent = resolutionQueueRef.current[0];
        if (!nextAgent) break;

        await generateResolutionResponse(nextAgent, currentTurnRef.current);
        if (abortRef.current) break;

        resolutionQueueRef.current = resolutionQueueRef.current.slice(1);
      }

      if (
        !abortRef.current &&
        phaseRef.current === "resolution" &&
        resolutionQueueRef.current.length === 0
      ) {
        if (!moderatorFinalSummaryPostedRef.current) {
          const summaryMessage = await generateModeratorMessage({
            kind: "final_summary",
            turn: currentTurnRef.current,
          });

          if (summaryMessage) {
            moderatorFinalSummaryPostedRef.current = true;
          } else {
            const fallbackSummary: ChatMessage = {
              id: `msg_${Date.now()}_moderator_fallback_summary`,
              agentId: "system",
              displayName: "Moderator",
              content:
                "Moderator summary unavailable because no summary provider is configured. Review the resolution round above for the final positions.",
              timestamp: Date.now(),
            };
            moderatorFinalSummaryPostedRef.current = true;
            setMessages((prev) => [...prev, fallbackSummary]);
            if (memoryManagerRef.current) {
              memoryManagerRef.current.addMessage(fallbackSummary);
            }
          }
        }

        phaseRef.current = "completed";
        setSessionStatus("completed");
        setIsPaused(false);
      }

      setIsRunning(false);
    },
    [
      topic,
      maxTurns,
      config.preferences.showBiddingScores,
      config.preferences.moderatorEnabled,
      generateBiddingScores,
      generateAgentResponse,
      generateModeratorMessage,
      generateResolutionResponse,
      configuredAgentIds,
      configuredProviders,
      normalizedSession.attachments,
      resetRuntimeState,
    ],
  );

  // Start discussion when providers become available
  useEffect(() => {
    if (!attachmentsReady) return;
    if (hasStartedRef.current) return;
    if (
      configuredProviders.length > 0 &&
      normalizedSession.status === "draft" &&
      normalizedSession.messages.length === 0
    ) {
      hasStartedRef.current = true;
      void runDiscussion("fresh");
    } else if (messages.length === 0) {
      setMessages([
        {
          id: `msg_${Date.now()}`,
          agentId: "system",
          content: `No API keys configured. Please go to Settings and configure at least one provider to start the discussion.`,
          timestamp: Date.now(),
          error: "No API keys configured",
        },
      ]);
    }
  }, [
    attachmentsReady,
    configuredProviders.length,
    messages.length,
    normalizedSession.messages.length,
    normalizedSession.status,
    runDiscussion,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current = true;
      for (const controller of activeRequestsRef.current.values()) {
        controller.abort();
      }
      activeRequestsRef.current.clear();
      moderatorAbortRef.current?.abort();
      moderatorAbortRef.current = null;
    };
  }, []);

  const handlePause = () => {
    abortRef.current = true;
    pausedRef.current = true;
    for (const controller of activeRequestsRef.current.values()) {
      controller.abort();
    }
    activeRequestsRef.current.clear();
    moderatorAbortRef.current?.abort();
    moderatorAbortRef.current = null;
    setIsRunning(false);
    setTypingAgents([]);
    setCurrentBidding(null);
    setShowBidding(false);
    setIsPaused(true);
    setSessionStatus("paused");
    setMessages((prev) => prev.filter((message) => !message.isStreaming));
  };

  const handlePauseResume = () => {
    if (isPaused) {
      hasStartedRef.current = true;
      void runDiscussion("resume");
    } else {
      handlePause();
    }
  };

  const handleBackToWorkstation = () => {
    if (isRunning) {
      handlePause();
    }
    onNavigate("home", normalizedSession.id);
  };

  const persistSessionSnapshot = useCallback(() => {
    const nextUpdatedAt = Date.now();
    const persistedMessages = messages.filter((message) => !message.isStreaming);
    const nextStatus: SessionStatus =
      phaseRef.current === "completed"
        ? "completed"
        : isPaused
          ? "paused"
          : isRunning
            ? "running"
            : sessionStatus;
    const messageFingerprint = persistedMessages.reduce((hash, message) => {
      const reactionCount = Object.values(message.reactions ?? {}).reduce(
        (count, reaction) => count + (reaction?.count ?? 0),
        0,
      );

      return (
        (hash * 31 +
          message.id.length +
          message.content.length +
          (message.error?.length ?? 0) +
          (message.thinking?.length ?? 0) +
          (message.fullResponse?.length ?? 0) +
          reactionCount) %
        2147483647
      );
    }, 7);
    const signature = [
      nextStatus,
      phaseRef.current,
      currentTurnRef.current,
      totalTokens.input,
      totalTokens.output,
      errors.join("|"),
      duoLogue?.remainingTurns ?? 0,
      resolutionQueueRef.current.join(","),
      messageFingerprint,
      persistedMessages.length,
    ].join("::");

    if (lastPersistSignatureRef.current === signature) {
      return;
    }
    lastPersistSignatureRef.current = signature;

    onPersistSession({
      id: normalizedSession.id,
      topic,
      title: normalizedSession.title,
      createdAt: normalizedSession.createdAt,
      updatedAt: nextUpdatedAt,
      lastOpenedAt: Math.max(normalizedSession.lastOpenedAt, normalizedSession.updatedAt),
      archivedAt: normalizedSession.archivedAt,
      status: nextStatus,
      currentTurn: currentTurnRef.current,
      totalTokens,
      moderatorUsage,
      messages: persistedMessages,
      errors,
      attachments: normalizedSession.attachments,
      duoLogue,
      runtime: {
        phase: phaseRef.current,
        cyclePending: cyclePendingRef.current,
        previousSpeaker: previousSpeakerRef.current,
        recentSpeakers: recentSpeakersRef.current,
        whisperBonuses: whisperBonusesRef.current,
        lastWhisperKey: lastWhisperKeyRef.current,
        lastModeratorKey: lastModeratorKeyRef.current,
        lastModeratorBalanceKey: lastModeratorBalanceKeyRef.current,
        lastModeratorSynthesisTurn: lastModeratorSynthesisTurnRef.current,
        moderatorResolutionPromptPosted: moderatorResolutionPromptPostedRef.current,
        moderatorFinalSummaryPosted: moderatorFinalSummaryPostedRef.current,
        resolutionQueue: resolutionQueueRef.current,
        resolutionNoticePosted: resolutionNoticePostedRef.current,
      },
    });

    setLastSavedAt(nextUpdatedAt);
  }, [
    errors,
    isPaused,
    isRunning,
    messages,
    moderatorUsage,
    normalizedSession.createdAt,
    normalizedSession.id,
    normalizedSession.attachments,
    normalizedSession.lastOpenedAt,
    normalizedSession.title,
    normalizedSession.updatedAt,
    onPersistSession,
    sessionStatus,
    topic,
    totalTokens,
    duoLogue,
  ]);

  useEffect(() => {
    persistSessionSnapshot();
  }, [persistSessionSnapshot]);

  const displayMaxTurns = maxTurns === Infinity ? "\u221E" : maxTurns;
  const formattedLastSavedAt = new Date(lastSavedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Format timestamp for Discord-style display
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const exportMessages = useMemo(() => {
    return messages
      .filter(
        (m) =>
          !m.isStreaming &&
          ((m.content ?? "").trim().length > 0 ||
            (m.fullResponse ?? "").trim().length > 0 ||
            (m.thinking ?? "").trim().length > 0),
      )
      .map((m) => {
        const agent = AGENT_CONFIG[m.agentId] ?? AGENT_CONFIG.system;
        const providerForModel = m.displayProvider ?? agent.provider;
        const modelName = m.metadata?.model
          ? getModelDisplayName(providerForModel, m.metadata.model)
          : undefined;
        const model = modelName && modelName !== "Unknown Model" ? modelName : undefined;
        return {
          id: m.id,
          agentId: m.agentId,
          speaker: m.displayName ?? agent.name,
          model,
          timestamp: m.timestamp,
          content: m.content,
          fullResponse: m.fullResponse || m.content,
          thinking: m.thinking,
          latencyMs: m.latencyMs ?? m.metadata?.latencyMs,
          tokens: m.tokens,
          costUSD: calculateMessageCost(m.metadata?.model, m.tokens),
        };
      });
  }, [messages, getModelDisplayName]);

  const totalEstimatedCostUSD = (costState?.totalEstimatedUSD ?? 0) + moderatorUsage.estimatedUSD;
  const hasAnyPricing =
    (costState
      ? Object.values(costState.agentCosts).some((agent) => agent.pricingAvailable)
      : false) || moderatorUsage.pricingAvailable;

  return (
    <div className="app-shell flex flex-col h-screen">
      <div className="ambient-canvas" aria-hidden="true" />
      {/* Header */}
      <div className="app-header px-6 py-4 relative z-10 chat-workstation-header">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="chat-session-hero">
            <button onClick={handleBackToWorkstation} className="button-ghost">
              &larr; Workstation
            </button>
            <div className="divider-vertical"></div>
            <div className="chat-session-mark">
              <CouncilMark size={34} />
            </div>
            <div className="chat-meta-stack">
              <div className="chat-kicker-row">
                <span className={`session-status session-status-${sessionStatus}`}>
                  {sessionStatus === "completed"
                    ? "Completed"
                    : isPaused
                      ? "Paused"
                      : isRunning
                        ? "Running"
                        : "Saved"}
                </span>
                <span className="chat-autosave-pill">
                  Autosaved locally at {formattedLastSavedAt}
                </span>
              </div>
              <h1 className="chat-session-title">Socratic Council</h1>
              <div className={`chat-session-topic-shell${isTopicExpanded ? " is-expanded" : ""}`}>
                <div className={`chat-session-topic-body${isTopicExpanded ? " is-expanded" : ""}`}>
                  <p
                    ref={topicBodyRef}
                    className={`chat-session-topic${isTopicExpanded ? " is-expanded" : ""}`}
                  >
                    {topic}
                  </p>
                </div>
                {(topicOverflowing || isTopicExpanded) && (
                  <button
                    type="button"
                    className="chat-session-topic-toggle"
                    onClick={() => setIsTopicExpanded((prev) => !prev)}
                  >
                    {isTopicExpanded ? "Collapse" : "Show full message"}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 justify-start xl:justify-end">
            <div className="flex items-center gap-2">
              <div className="text-sm text-ink-500">
                Turn {currentTurn}/{displayMaxTurns}
              </div>
              {maxTurns !== Infinity && (
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min((currentTurn / maxTurns) * 100, 100)}%` }}
                  />
                </div>
              )}
            </div>

            <div className="badge badge-info">{totalTokens.input + totalTokens.output} tokens</div>

            {costState && (
              <div className="badge">
                {hasAnyPricing ? `$${totalEstimatedCostUSD.toFixed(4)}` : "$N/A"}
              </div>
            )}

            {duoLogue && (
              <div className="badge badge-warning">
                Conflict Focus · {duoLogue.remainingTurns} turns
              </div>
            )}

            <button
              onClick={() => setSidePanelView((prev) => (prev === "logs" ? "default" : "logs"))}
              className="button-secondary text-sm"
            >
              Logs {errors.length > 0 && `(${errors.length})`}
            </button>

            <button
              onClick={() => setSidePanelView((prev) => (prev === "search" ? "default" : "search"))}
              className="button-secondary text-sm"
            >
              Search
            </button>

            <button
              onClick={() => setSidePanelView((prev) => (prev === "export" ? "default" : "export"))}
              className="button-secondary text-sm"
            >
              Export
            </button>

            {sessionStatus !== "completed" &&
              (isRunning || isPaused || sessionStatus === "paused" || currentTurn > 0) && (
                <button
                  onClick={handlePauseResume}
                  className={`session-control-button ${isPaused ? "is-resume" : ""}`}
                  title={isPaused ? "Resume session" : "Pause and save session"}
                >
                  <span className="session-control-icon">
                    {isPaused ? (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.25"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polygon points="8 6 18 12 8 18 8 6" fill="currentColor" stroke="none" />
                      </svg>
                    ) : (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.25"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="10" y1="7" x2="10" y2="17" />
                        <line x1="14" y1="7" x2="14" y2="17" />
                      </svg>
                    )}
                  </span>
                  <span>{isPaused ? "Resume Session" : "Pause & Save"}</span>
                </button>
              )}
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative z-10">
        {/* Messages area - Discord style */}
        <div className="flex-1 relative overflow-hidden">
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: "100%" }}
            className="overflow-y-auto"
            data={messages}
            computeItemKey={(_, item) => item.id}
            followOutput={(isAtBottom) =>
              config.preferences.autoScroll && isAtBottom ? "smooth" : false
            }
            atBottomStateChange={(atBottom) => {
              isAtBottomRef.current = atBottom;
              setShowScrollButton(!atBottom);
            }}
            components={virtuosoComponents}
            itemContent={(_, message) => {
              const agent = AGENT_CONFIG[message.agentId] ?? AGENT_CONFIG.system;
              const isAgent = isCouncilAgent(message.agentId);
              const isSystem = message.agentId === "system";
              const isTool = message.agentId === "tool";
              const isModerator = isModeratorMessage(message);
              const displayName =
                typeof message.displayName === "string" && message.displayName.trim()
                  ? message.displayName
                  : agent.name;
              const nameClass = isModerator ? "text-emerald-300" : agent.color;
              const providerForDisplay = message.displayProvider ?? agent.provider;
              const modelName = message.metadata?.model
                ? getModelDisplayName(providerForDisplay, message.metadata.model)
                : "";
              const accent = isModerator
                ? "var(--accent-emerald)"
                : isSystem
                  ? "var(--accent-ink)"
                  : isTool
                    ? "var(--accent-ink)"
                    : message.agentId === "user"
                      ? "var(--accent-emerald)"
                      : `var(--color-${message.agentId})`;
              const accentStyle = { "--accent": accent } as CSSProperties;
              const reactionEntries = message.reactions
                ? (
                    Object.entries(message.reactions) as [
                      ReactionId,
                      { count: number; by: string[] },
                    ][]
                  ).filter(([, reaction]) => reaction?.count)
                : [];

              // Determine message status classes
              const isSuccess =
                isAgent && !message.isStreaming && !message.error && message.content;
              const messageStatusClass = message.error
                ? "has-error"
                : isSuccess
                  ? "message-success"
                  : message.isStreaming
                    ? "is-streaming"
                    : "";

              const isHighlighted = highlightedMessageId === message.id;

              return (
                <div
                  id={message.id}
                  className={`discord-message message-enter ${messageStatusClass} ${isHighlighted ? "message-highlight" : ""}`}
                  style={accentStyle}
                >
                  {/* Avatar */}
                  <div className="discord-avatar">
                    {isSystem || isTool ? (
                      message.displayProvider ? (
                        <ProviderIcon provider={message.displayProvider} size={40} />
                      ) : (
                        <SystemIcon size={40} />
                      )
                    ) : message.agentId === "user" ? (
                      <UserIcon size={40} />
                    ) : (
                      <ProviderIcon provider={agent.provider} size={40} />
                    )}
                    {isCouncilAgent(message.agentId) &&
                      typingAgents.includes(message.agentId) &&
                      message.isStreaming && <div className="avatar-speaking-indicator" />}
                  </div>

                  {/* Message content */}
                  <div className="discord-message-content">
                    {/* Header: Name (Model) + timestamp */}
                    <div className="discord-message-header">
                      <span className={`discord-username ${nameClass}`}>{displayName}</span>
                      {(isAgent || isModerator) && modelName && (
                        <span className="discord-model">({modelName})</span>
                      )}
                      {(isAgent || isModerator) && !!message.thinking?.trim() && (
                        <span
                          className={`discord-thinking-pill${message.isStreaming ? "" : " is-complete"}`}
                        >
                          {message.isStreaming ? "Thinking" : "Thought Summary"}
                        </span>
                      )}
                      {(isAgent || isModerator) &&
                        (message.isStreaming || message.latencyMs != null) && (
                          <LiveStopwatch
                            startTime={message.timestamp}
                            isStreaming={!!message.isStreaming}
                            finalMs={message.latencyMs}
                          />
                        )}
                      <span className="discord-timestamp">{formatTime(message.timestamp)}</span>
                      {message.tokens && (
                        <span className="discord-tokens">
                          {message.tokens.input}+{message.tokens.output}
                          {message.tokens.reasoning && message.tokens.reasoning > 0
                            ? ` +r${message.tokens.reasoning}`
                            : ""}{" "}
                          tokens
                        </span>
                      )}
                      {(() => {
                        const msgCost = calculateMessageCost(
                          message.metadata?.model,
                          message.tokens,
                        );
                        return msgCost !== null ? (
                          <span className="discord-cost">${msgCost.toFixed(4)}</span>
                        ) : null;
                      })()}
                    </div>

                    {/* Message body */}
                    <div className="discord-message-body">
                      {message.isStreaming ? (
                        <div className="markdown-content" style={{ whiteSpace: "pre-wrap" }}>
                          {message.content}
                        </div>
                      ) : (
                        splitIntoInlineQuoteSegments(message.content).map((segment, idx) => {
                          if (segment.type === "quote") {
                            const qm = messageById.get(segment.id);
                            if (!qm) {
                              return (
                                <div key={`${message.id}-quote-${idx}`} className="message-quote">
                                  <div className="message-quote-header">
                                    Missing quote · @quote({segment.id})
                                  </div>
                                  <div className="message-quote-body">Message not found.</div>
                                </div>
                              );
                            }

                            const qReactions = qm.reactions
                              ? (
                                  Object.entries(qm.reactions) as [
                                    ReactionId,
                                    { count: number; by: string[] },
                                  ][]
                                ).filter(([, r]) => r?.count)
                              : [];

                            const strippedContent = stripQuoteTokens(qm.content);
                            const truncated = strippedContent.slice(0, 200);
                            const ellipsis = strippedContent.length > 200 ? "\u2026" : "";

                            return (
                              <div
                                key={`${message.id}-quote-${idx}`}
                                className="message-quote message-quote-clickable"
                                onClick={() => jumpToMessage(segment.id)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") jumpToMessage(segment.id);
                                }}
                              >
                                <div className="message-quote-header">
                                  {qm.displayName ?? AGENT_CONFIG[qm.agentId].name} ·{" "}
                                  {formatTime(qm.timestamp)}
                                </div>
                                <div className="message-quote-body">
                                  {truncated}
                                  {ellipsis}
                                </div>
                                {qReactions.length > 0 && (
                                  <div className="message-quote-reactions">
                                    {qReactions.map(([reactionId, reaction]) => (
                                      <div key={reactionId} className="reaction-chip">
                                        <ReactionIcon type={reactionId} size={14} />
                                        <span>{reaction.count}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          }

                          if (!segment.text) return null;
                          if (segment.text.trim() === "") {
                            return (
                              <div
                                key={`${message.id}-text-${idx}`}
                                className="markdown-content"
                                style={{ whiteSpace: "pre-wrap" }}
                              >
                                {segment.text}
                              </div>
                            );
                          }

                          return (
                            <Markdown
                              key={`${message.id}-text-${idx}`}
                              content={segment.text}
                              className="markdown-content"
                            />
                          );
                        })
                      )}
                      {message.toolEvents?.length ? (
                        <div className="message-tool-list">
                          {message.toolEvents.map((event) => (
                            <details
                              key={event.id}
                              className={`message-tool-call${event.error ? " has-error" : ""}`}
                            >
                              <summary className="message-tool-summary">
                                <span>{event.summary}</span>
                              </summary>
                              <div className="message-tool-body">
                                <div className="message-tool-meta">
                                  {getToolDisplayName(event.name as ToolCall["name"])} ·{" "}
                                  {formatTime(event.timestamp)}
                                </div>
                                <div className="message-tool-output">
                                  {event.error
                                    ? `Error: ${event.error}\n\n${event.output}`
                                    : event.output}
                                </div>
                              </div>
                            </details>
                          ))}
                        </div>
                      ) : null}
                      {message.isStreaming && (
                        <span className="typing-indicator">
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                        </span>
                      )}
                      {!!message.thinking?.trim() && (
                        <details className="thinking-panel">
                          <summary className="thinking-summary">
                            Thought Summary ({message.thinking.length.toLocaleString()} chars)
                          </summary>
                          <div className="thinking-content">{message.thinking}</div>
                        </details>
                      )}
                    </div>

                    <div className="message-actions">
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => copyQuoteToken(message.id)}
                        title="Copy @quote() token to clipboard"
                      >
                        {recentlyCopiedQuote === message.id ? "Copied" : "Quote"}
                      </button>
                      <button
                        type="button"
                        className="message-action"
                        onClick={() =>
                          setReactionPickerTarget((prev) =>
                            prev === message.id ? null : message.id,
                          )
                        }
                        title="Add a reaction"
                      >
                        React
                      </button>
                    </div>

                    {reactionPickerTarget === message.id && (
                      <div className="reaction-picker" role="dialog" aria-label="Reaction picker">
                        {REACTION_CATALOG.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="reaction-picker-item"
                            onClick={() => {
                              toggleUserReaction(message.id, emoji);
                              setReactionPickerTarget(null);
                            }}
                            title={emoji}
                            aria-label={`React ${emoji}`}
                          >
                            <ReactionIcon type={emoji} size={18} />
                          </button>
                        ))}
                      </div>
                    )}

                    {reactionEntries.length > 0 && (
                      <div className="reaction-bar">
                        {reactionEntries.map(([reactionId, reaction]) => (
                          <div key={reactionId} className="reaction-chip">
                            <ReactionIcon type={reactionId} size={16} />
                            <span>{reaction.count}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Error message */}
                    {message.error && <div className="discord-error">{message.error}</div>}
                  </div>
                </div>
              );
            }}
          />

          {/* Scroll to bottom button */}
          {showScrollButton && (
            <button
              onClick={scrollToBottom}
              className="scroll-to-bottom-button"
              title="Scroll to bottom"
              aria-label="Scroll to bottom"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>

        {/* Right sidebar - Agent status & Bidding */}
        <div className="w-full md:w-80 md:border-l border-line-soft side-panel p-4 overflow-y-auto">
          {sidePanelView === "logs" ? (
            // Logs panel
            <div className="scale-in">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
                  API Logs
                </h3>
                <button
                  onClick={() => setSidePanelView("default")}
                  className="button-ghost text-xs"
                >
                  Close
                </button>
              </div>
              <div className="space-y-2 text-xs">
                {apiLogger
                  .getLogs()
                  .slice(-20)
                  .reverse()
                  .map((log, i) => (
                    <div
                      key={i}
                      className={`log-card ${log.level === "error" ? "error" : log.level === "warn" ? "warn" : ""}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium">[{log.provider}]</span>
                        <span className="text-ink-500">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div>{log.message}</div>
                    </div>
                  ))}
                {apiLogger.getLogs().length === 0 && (
                  <div className="text-ink-500 text-center py-4">No logs yet</div>
                )}
              </div>
            </div>
          ) : sidePanelView === "search" ? (
            <ConversationSearch
              messages={messages
                .filter((m) => (m.content ?? "").trim().length > 0)
                .map((m) => ({
                  id: m.id,
                  agentId: m.displayName ?? String(m.agentId),
                  content: m.content,
                  timestamp: m.timestamp,
                }))}
              getAgentLabel={getAgentLabel}
              onJumpToMessage={jumpToMessage}
              onClose={() => setSidePanelView("default")}
            />
          ) : sidePanelView === "export" ? (
            <ConversationExport
              topic={topic}
              messages={exportMessages}
              onClose={() => setSidePanelView("default")}
            />
          ) : (
            <>
              <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-4">
                Council Members
              </h3>

              {/* Agent list with provider icons */}
              <div className="space-y-2 mb-6">
                {AGENT_IDS.map((agentId) => {
                  const agent = AGENT_CONFIG[agentId];
                  const isSpeaking = typingAgents.includes(agentId);
                  const hasApiKey = configuredProviders.includes(agent.provider);
                  const modelName = getModelDisplayName(agent.provider);

                  return (
                    <div
                      key={agentId}
                      className={`agent-row ${isSpeaking ? "speaking" : ""} ${!hasApiKey ? "opacity-50" : ""}`}
                    >
                      <div className={`relative ${isSpeaking ? "speaking-pulse" : ""}`}>
                        <ProviderIcon provider={agent.provider} size={32} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${agent.color}`}>
                          {agent.name}
                        </div>
                        <div className="text-xs text-ink-500 truncate">
                          {hasApiKey ? modelName : "No API key"}
                        </div>
                      </div>
                      {isSpeaking && <span className="badge badge-success text-xs">Speaking</span>}
                    </div>
                  );
                })}
              </div>

              <ConflictGraph
                conflicts={allConflicts}
                agents={AGENT_IDS.map((id) => ({
                  id,
                  name: AGENT_CONFIG[id].name,
                  color: AGENT_CONFIG[id].color,
                }))}
              />

              {/* Bidding display */}
              {showBidding && currentBidding && (
                <div className="scale-in">
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3">
                    Bidding Round
                  </h3>
                  <div className="panel-card p-3 space-y-2">
                    {(Object.entries(currentBidding.scores) as [CouncilAgentId, number][])
                      .filter(([_, score]) => score > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([agentId, score]) => {
                        const agent = AGENT_CONFIG[agentId];
                        const isWinner = agentId === currentBidding.winner;
                        const maxScore = Math.max(...Object.values(currentBidding.scores));
                        const barWidth = (score / maxScore) * 100;

                        return (
                          <div key={agentId} className={`${isWinner ? "winner-highlight" : ""}`}>
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className={`flex items-center gap-1 ${agent.color}`}>
                                <ProviderIcon provider={agent.provider} size={14} />
                                {agent.name}
                              </span>
                              <span className="text-ink-500">
                                {score.toFixed(1)}
                                {isWinner && " \u2605"}
                              </span>
                            </div>
                            <div className="h-1.5 bg-white/70 rounded-full overflow-hidden">
                              <div
                                className={`h-full bidding-bar rounded-full ${
                                  isWinner
                                    ? "bg-gradient-to-r from-emerald-600 to-amber-400"
                                    : "bg-slate-400"
                                }`}
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              <div className="panel-card p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
                    Cost Ledger
                  </h3>
                  <span className="badge text-xs">
                    {totalTokens.input + totalTokens.output} tokens
                  </span>
                </div>
                {costState ? (
                  <div className="space-y-2 text-xs">
                    {AGENT_IDS.map((agentId) => {
                      const agent = AGENT_CONFIG[agentId];
                      const breakdown = costState.agentCosts[agentId];
                      const costLabel = breakdown?.pricingAvailable
                        ? `$${breakdown.estimatedUSD.toFixed(4)}`
                        : "—";
                      const inputTokens = breakdown?.inputTokens ?? 0;
                      const outputTokens = breakdown?.outputTokens ?? 0;
                      const reasoningTokens = breakdown?.reasoningTokens ?? 0;

                      return (
                        <div key={agentId} className="flex items-center justify-between">
                          <span className={`text-ink-700 ${agent.color}`}>{agent.name}</span>
                          <span className="text-ink-500">
                            {inputTokens}/{outputTokens} · r:{reasoningTokens} · {costLabel}
                          </span>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between">
                      <span className="text-emerald-300">Moderator</span>
                      <span className="text-ink-500">
                        {moderatorUsage.inputTokens}/{moderatorUsage.outputTokens} · r:
                        {moderatorUsage.reasoningTokens} ·{" "}
                        {moderatorUsage.pricingAvailable
                          ? `$${moderatorUsage.estimatedUSD.toFixed(4)}`
                          : "—"}
                      </span>
                    </div>
                    <div className="pt-2 border-t border-line-soft flex items-center justify-between">
                      <span className="text-ink-500">Estimated total</span>
                      <span className="text-ink-900">
                        {hasAnyPricing
                          ? `$${totalEstimatedCostUSD.toFixed(4)}`
                          : "Pricing not configured"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-ink-500">No usage recorded yet.</div>
                )}
              </div>

              {/* Discussion stats */}
              {!isRunning && currentTurn > 0 && (
                <div className="mt-6 scale-in">
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3">
                    Summary
                  </h3>
                  <div className="panel-card p-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Total turns</span>
                      <span className="text-ink-900">{currentTurn}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Messages</span>
                      <span className="text-ink-900">{messages.length}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Total tokens</span>
                      <span className="text-ink-900">{totalTokens.input + totalTokens.output}</span>
                    </div>
                    {errors.length > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-ink-500">Errors</span>
                        <span className="text-ink-900">{errors.length}</span>
                      </div>
                    )}
                    <div className="pt-2 border-t border-line-soft">
                      <button
                        onClick={() => {
                          onNavigate("home", normalizedSession.id);
                        }}
                        className="w-full button-primary text-sm"
                      >
                        Back To Workstation
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer - Current speaker indicator */}
      {typingAgents.length > 0 && (
        <div className="app-footer px-6 py-3">
          <div className="flex items-center justify-center gap-3 text-sm">
            {typingAgents.slice(0, 3).map((agentId) => (
              <span key={agentId} className="flex items-center gap-2">
                <ProviderIcon provider={AGENT_CONFIG[agentId].provider} size={18} />
                <span className={AGENT_CONFIG[agentId].color}>{AGENT_CONFIG[agentId].name}</span>
              </span>
            ))}
            {typingAgents.length > 3 && (
              <span className="text-ink-500">+{typingAgents.length - 3}</span>
            )}
            <span className="text-ink-500">typing...</span>
            <span className="typing-indicator ml-2">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
