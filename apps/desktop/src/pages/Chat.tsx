import { useState, useEffect, useRef, useCallback, useMemo, forwardRef } from "react";
import type { CSSProperties, HTMLAttributes } from "react";
import type { Page } from "../App";
import { useConfig, PROVIDER_INFO, type Provider } from "../stores/config";
import { callProvider, apiLogger, type ChatMessage as APIChatMessage } from "../services/api";
import {
  loadSessionAttachmentBlobs,
  type SessionAttachment,
} from "../services/attachments";
import {
  type DeepResearchReportSnapshot,
  type DiscussionSession,
  type EndVoteChoice,
  type EndVoteBallotSnapshot,
  type EndVoteBoardSnapshot,
  type EndVoteSnapshot,
  type HandoffSnapshot,
  type ModeratorConclusionSnapshot,
  type ModeratorUsageSnapshot,
  type SessionMessage as PersistedSessionMessage,
  type SessionPhase,
  type SessionStatus,
  type SessionToolEvent,
} from "../services/sessions";
import { getToolPrompt, runToolCall, type ToolCall, type ToolContext } from "../services/tools";
import {
  generateDeepResearchReport,
  type TranscriptMessage as DeepResearchTranscriptMessage,
} from "../services/deepResearch";
import { addDossierEntry, loadProject } from "../services/projects";
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
import { extractHandoffDirective } from "../utils/handoff";
import { createStreamingToolCallDetector, extractActions, stripProviderToolSyntax } from "../utils/toolActions";
import { splitIntoInlineQuoteSegments, stripQuoteTokens } from "../utils/inlineQuotes";
import {
  type CanvasState,
  applyCanvasDirective,
  extractCanvasDirectives,
} from "../utils/canvasActions";
import { AgentCanvas } from "../components/AgentCanvas";
import { useObserverCircle } from "./useObserverCircle";
import type { ObserverNoteSnapshot } from "../services/sessions";
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
  onPersistSession: (session: DiscussionSession) => DiscussionSession;
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

type EndVoteState = EndVoteSnapshot;
type EndVoteChoiceMap = Partial<Record<CouncilAgentId, EndVoteChoice>>;

type EndVoteReasonMap = Partial<Record<CouncilAgentId, string>>;
type PendingHandoffState = HandoffSnapshot;

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
  "qwen3.6-plus": "Qwen 3.6 Plus",
  "qwen3.5-plus": "Qwen 3.5 Plus",
  // MiniMax
  "MiniMax-M2.7-highspeed": "MiniMax M2.7",
  "minimax-m2.7-highspeed": "MiniMax M2.7",
  // Zhipu
  "glm-5.1": "GLM-5.1",
  "glm-5": "GLM-5",
  "glm-4.7": "GLM-4.7",
};

const MULTILINGUAL_STYLE_GUIDE = `
Language & natural voice:
- Match the language the user wrote the topic in. If the topic is in Chinese, respond in Chinese; if Japanese, respond in Japanese; and so on. Never silently switch to English.
- The goal is to sound like a fluent native speaker in a group chat — not like a translated-from-English AI. Literal English sentence structure ruins this.
- If you genuinely cannot produce natural prose in the user's language, say so briefly in English and explain what you need.

Per-language guidance (follow when writing in these languages):

中文 (Chinese): Write short topic-comment sentences, not translated English subordinate clauses. Drop unnecessary "的" chains. Use 就、才、还、都、其实、不过、而且、而是 naturally as discourse connectors instead of calquing English "however/moreover/actually". Minimize relative clauses — split into two sentences. End with 了、吧、呢、啊 when the mood calls for it. Avoid stilted formal register unless the topic is formal. Never literally translate English idioms ("at the end of the day", "circle back", etc.). Use measure words correctly (一个、一种、一件) and don't over-pronoun — Chinese is pro-drop.

日本語 (Japanese): Use です/ます consistently in a public group chat. Drop the subject (私) when context makes it obvious — Japanese is heavily pro-drop. Use ね・よ・な sentence-final particles sparingly but where they add natural softness. Pick は vs が correctly (topic vs subject). Avoid direct-object-first English word order — Japanese is SOV. Keep sentences shorter than your English instinct suggests. For counterarguments, soften with でも、けど、とはいえ、ただ rather than blunt negation.

한국어 (Korean): Use 해요체 (polite informal) by default for group chat. Don't over-translate English "the/a" — Korean has no articles. Use 는/은 for topic and 이/가 for new-information subject. Sentence-final endings like -거든요, -죠, -잖아요 feel natural for explanations and rhetorical questions. Honorific forms (-시-) matter when referring to others. Keep sentences shorter than the English equivalent; Korean punishes run-ons.

العربية (Arabic): Prefer Modern Standard Arabic (فصحى) for formal debate, but allow conversational phrasing. Connective particles فـ، و، لكن، إذن carry the flow — use them instead of calqued English transitions. Sentences can be VSO (verb-first) when natural. Avoid literal translations of English idioms. Pay attention to gender agreement in adjectives and verbs.

Español / Français / Português / Italiano: Use normal Romance-language conversational register. Natural connectors — pues, bueno, entonces; alors, bon, du coup; então, bem, aí; beh, allora. Use subjunctive where the grammar demands it (after esperar que, quiero que, etc.). Avoid English-style over-formality. Drop pronouns when the verb conjugation makes them obvious — these languages are pro-drop.

Deutsch (German): Observe V2 word order in main clauses and verb-final in subordinate clauses (dass, weil, obwohl, ...). Use du in group chat register (group chat = informal). Avoid English-style long noun chains; use German compounds only when they exist. Connectors: denn, doch, aber, allerdings, jedoch carry nuance.

Русский / Українська (Russian / Ukrainian): Take advantage of free word order for emphasis — front the word you want stressed. Use discourse particles ведь, же, то, ж naturally. Never translate English "the/a" — there are no articles. Sentences can be shorter than English instincts suggest; avoid over-translating subordinate clauses.

हिन्दी / اردو (Hindi / Urdu): SOV word order. Use ही, तो, भी (or کو، بھی، ہی) as emphasis particles. Match register to the group: for Hindi-leaning register, prefer Sanskrit-derived vocabulary; for Urdu-leaning register, prefer Persian/Arabic-derived vocabulary. Polite form आप / آپ.

General don't-do list:
- Don't translate English idioms literally.
- Don't use English punctuation/capitalization rules (e.g., don't capitalize every word in headings in languages that don't do that).
- Don't overuse pronouns in pro-drop languages.
- Don't mix scripts unless the discussion already does.
- Don't default to stiff formal register — match the chat tone of the topic.
- If you quote English text from attachments, keep the English quote verbatim but write your commentary in the conversation's language.
`;

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
- Attached PDFs, images, DOCX, XLSX, and other non-code files are NOT visible as full files. Only a compact manifest appears in your context. To see their contents, call oracle.file_search with a targeted query — that returns OCR'd or extracted snippets. Only code and plain-text files are inlined in full.
- Proactively call oracle.file_search for attached-file evidence and oracle.web_search for current external facts when that would materially improve the answer.
- When a tool returns new information, REVISE any earlier claims in your current turn that the new evidence contradicts. Do not leave stale assertions — treat your in-progress message as a draft you must update in light of what you just learned.
- If you know you need a tool, emit only the @tool(name, {args}) line and stop. The app will execute it and return control to you.
- If the room has clearly converged and more debate would be repetitive, append @end() on its own line after your visible closing message to request the closing round.
- If you need one specific agent to answer next, append exactly one standalone line: @handoff({"to":"cathy","question":"one precise follow-up question"}). You may only hand off to an agent who has NOT already spoken this round. If the agent you want has already spoken, wait until the next round.
- If a retrieved passage looks incomplete, do one more targeted search until you have enough surrounding context.
- Call tools early instead of burning time in hidden reasoning before the search starts.
- Ask at most one concrete question, and only if it materially helps the group decide. Do not force a question every turn.
- If the Moderator shifts the room toward resolution, stop broadening the debate and help land a final result.
- Never emit tool_use, tool_call, function_call, XML tool tags, or provider-specific tool syntax. Use only the literal @tool(name, {args}) format.

Markdown:
- Markdown is supported (GFM tables, links, **bold**, \`code\`, fenced code blocks, and LaTeX math via $...$ / $$...$$).
- Prefer plain text for normal conversations. Use Markdown only when it materially improves clarity (math, CS, structured data).
- If you use math/code, write the *real* formula/code (not placeholders).
${MULTILINGUAL_STYLE_GUIDE}
Quoting/Reactions:
- You MUST include @quote(MSG_ID) for a specific prior message. You can quote MULTIPLE messages from different speakers or even the same speaker: @quote(MSG_A) @quote(MSG_B).
- NEVER fabricate or invent quotes. Only use @quote(MSG_ID) with an actual message ID visible in the conversation above. If no prior messages exist, do not quote anything.
- If it fits, include @react(MSG_ID, 👍|👎|❤️|😂|😮|😢|😡|✨|🎉).

${getToolPrompt()}
`;

// Map from agent display name to their outer-circle partner name
const AGENT_NAME_TO_PARTNER: Record<string, string> = {
  George: "Greta", Cathy: "Clara", Grace: "Gaia", Douglas: "Dara",
  Kate: "Kira", Quinn: "Quincy", Mary: "Mila", Zara: "Zoe",
};

const BASE_SYSTEM_PROMPT = (
  name: string,
) => {
  const partnerName = AGENT_NAME_TO_PARTNER[name];
  const partnerLine = partnerName
    ? `\nOuter-circle partner: You have a silent partner named ${partnerName} who observes the discussion and may send you private notes marked "[Private note from ${partnerName}]". When ${partnerName} raises a substantive point worth sharing, naturally weave it into your argument — e.g. "my partner ${partnerName} points out…" or "as ${partnerName} noted…". If the note is only about your delivery or strategy (not a new argument), follow the advice silently without mentioning it.\n`
    : "";

  return `You are ${name} in a group chat with George, Cathy, Grace, Douglas, Kate, Quinn, Mary, and Zara.

Do NOT adopt a persona or specialty. Speak as yourself, and keep the tone natural.
Do NOT fabricate facts, invent sources, or hallucinate quotes. Only reference messages you can actually see above.
${partnerLine}
Proactive behavior requirements:
- If someone is vague, force precision by asking for a measurable claim.
- If someone makes a strong claim, pressure-test it with one concrete challenge.
- If the room is converging too quickly without enough evidence, introduce one serious dissenting angle.
- Once the evidence is good enough, help the group converge on a defensible recommendation instead of reopening settled points.
- If someone has been quiet recently, invite them by name into the exact point of dispute.
- The goal is not endless debate. Surface the real disagreement early, then help the group reach a clear closing result.

${GROUP_CHAT_GUIDELINES}`;
};

const MODERATOR_SYSTEM_PROMPT = `You are the Moderator in a group chat with George, Cathy, Grace, Douglas, Kate, Quinn, Mary, and Zara.

Your job: keep the discussion focused, fair, rigorous, and productive. Be direct and demanding — call out weak reasoning, vague claims, and circular arguments.

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
  8) final outcome publication after the closing round, with a score/10 and explanation.
- Keep interventions sparse and high-signal to avoid unnecessary cost.
- You may suggest who should respond next by name.
- At the end, publish the official closing result with a score/10 and explanation instead of leaving the room with another open question.
- Be a harsh, honest grader. A score of 7+ requires concrete evidence cited, falsifiable criteria, and genuine disagreement resolved with clear reasoning. Most discussions deserve 4–6. Give 8+ only if the group produced a defensible, evidence-backed recommendation. Discussions that stayed abstract, repetitive, or hand-wavy should score 3–5.
- Do NOT include @quote(...), @react(...), @tool(...), @vote(...), or @end() unless the specific prompt explicitly asks for it.
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
  zara: {
    name: "Zara",
    color: "text-zara",
    bgColor: "bg-zara/10",
    borderColor: "border-zara",
    provider: "zhipu",
    systemPrompt: BASE_SYSTEM_PROMPT("Zara"),
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
  "zara",
];

const AGENT_PARTNERS: Record<CouncilAgentId, string> = {
  george: "Greta",
  cathy: "Clara",
  grace: "Gaia",
  douglas: "Dara",
  kate: "Kira",
  quinn: "Quincy",
  mary: "Mila",
  zara: "Zoe",
};

const isCouncilAgent = (id: unknown): id is CouncilAgentId =>
  AGENT_IDS.includes(id as CouncilAgentId);

const isModeratorMessage = (msg: unknown): boolean => {
  if (!msg || typeof msg !== "object") return false;
  const record = msg as Record<string, unknown>;
  return record.agentId === "system" && record.displayName === "Moderator";
};

const hasStructuredVoteArtifacts = (msg: unknown): boolean => {
  if (!msg || typeof msg !== "object") return false;
  const record = msg as Record<string, unknown>;
  return Boolean(record.endVoteBallot || record.endVoteBoard);
};

const REACTION_IDS = REACTION_CATALOG;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_TOOL_ITERATIONS = 6;
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
    zara: 0,
  };
}

function countEndVoteChoices(
  votes: EndVoteChoiceMap,
  configuredAgentIds: readonly CouncilAgentId[],
): { yes: number; no: number } {
  let yes = 0;
  let no = 0;

  for (const agentId of configuredAgentIds) {
    if (votes[agentId] === "yes") {
      yes += 1;
    } else if (votes[agentId] === "no") {
      no += 1;
    }
  }

  return { yes, no };
}

function getEndVoteThreshold(configuredAgentIds: readonly CouncilAgentId[]) {
  return Math.floor(configuredAgentIds.length / 2) + 1;
}

function parseVoteChoiceFromVisibleText(content: string): EndVoteChoice | null {
  const match = content.match(/^\s*Vote:\s*(YES|NO)\b/i);
  if (!match) return null;
  return match[1]?.toLowerCase() === "no" ? "no" : "yes";
}

function stripLegacyEndVoteDirective(raw: string) {
  let voteChoice: EndVoteChoice | null = null;

  const cleaned = raw.replace(
    /(^|\n)[ \t]*@vote\(end,\s*(yes|no)\)[ \t]*(\n|$)/gi,
    (_match, prefix: string, choice: string, suffix: string) => {
      voteChoice = choice.toLowerCase() === "no" ? "no" : "yes";
      return prefix && suffix ? "\n" : "";
    },
  );

  return {
    cleaned: normalizeMessageText(cleaned),
    voteChoice,
  };
}

function extractVoteReasonFromVisibleText(choice: EndVoteChoice | null, content: string) {
  if (!choice) return "";

  const pattern = choice === "no" ? /^\s*Vote:\s*NO\b[:.!-]?\s*/i : /^\s*Vote:\s*YES\b[:.!-]?\s*/i;
  return normalizeMessageText(content).replace(pattern, "").trim();
}

function hasRequiredVoteReason(choice: EndVoteChoice | null, reason: string) {
  return choice !== "no" || reason.trim().length >= 16;
}

function buildEndVoteBallotContent(ballot: EndVoteBallotSnapshot) {
  const prefix = ballot.choice === "yes" ? "Submitted a YES vote." : "Submitted a NO vote.";
  return ballot.reason ? `${prefix} ${ballot.reason}` : prefix;
}

function buildEndVoteBoardContent(board: EndVoteBoardSnapshot) {
  const { yes, no } = countEndVoteChoices(board.votes, board.agentOrder);
  const pending = Math.max(board.totalAgents - yes - no, 0);
  const statusText =
    board.status === "passed"
      ? "Passed"
      : board.status === "failed"
        ? "Failed"
        : board.status === "complete"
          ? "Complete"
          : "Active";

  return `End vote round ${board.round}: YES ${yes}, NO ${no}, Pending ${pending}. ${statusText}${
    board.outcome ? ` ${board.outcome}` : ""
  }`;
}

function buildModeratorConclusionContent(conclusion: ModeratorConclusionSnapshot) {
  const label =
    conclusion.status === "consensus"
      ? "Consensus"
      : conclusion.status === "majority"
        ? "Majority with dissent"
        : "Unresolved";

  return [
    `${label}: ${conclusion.summary}`,
    `Score: ${conclusion.score}/10.`,
    conclusion.reason,
    conclusion.next ? `Next: ${conclusion.next}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseModeratorConclusionFromText(content: string): ModeratorConclusionSnapshot | null {
  const normalized = normalizeMessageText(content);
  if (!normalized) return null;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const labelLine = lines[0] ?? "";
  const summaryMatch = labelLine.match(/^(Consensus|Majority with dissent|Unresolved):\s*(.+)$/i);
  if (!summaryMatch) return null;

  const scoreLine = lines.find((line) => /^Score:\s*\d+\s*\/\s*10\.?$/i.test(line));
  if (!scoreLine) return null;
  const scoreMatch = scoreLine.match(/^Score:\s*(\d+)\s*\/\s*10\.?$/i);
  if (!scoreMatch) return null;

  const statusLabel = summaryMatch[1]?.toLowerCase();
  const status =
    statusLabel === "consensus"
      ? "consensus"
      : statusLabel === "majority with dissent"
        ? "majority"
        : "unresolved";

  const reasonCandidates = lines.filter((line) => line !== labelLine && line !== scoreLine);
  const reason = reasonCandidates[0] ?? "";
  if (!reason) return null;

  return {
    status,
    summary: summaryMatch[2]?.trim() ?? "",
    score: Math.max(0, Math.min(10, Number(scoreMatch[1]))),
    reason,
    ...(reasonCandidates[1] ? { next: reasonCandidates[1].replace(/^Next:\s*/i, "").trim() } : {}),
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

function StatusGlyph({
  status,
  size = 16,
}: {
  status: ModeratorConclusionSnapshot["status"];
  size?: number;
}) {
  if (status === "consensus") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
        <path d="M4.5 8.2 6.8 10.5 11.6 5.7" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }

  if (status === "majority") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
        <path d="M5 10.5 8 5.5 11 10.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.2 9.2h3.6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
      <path d="M5 5 11 11M11 5 5 11" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function VotePieChart({ yes, no, pending }: { yes: number; no: number; pending: number }) {
  const total = Math.max(yes + no + pending, 1);
  const yesDeg = (yes / total) * 360;
  const noDeg = yesDeg + (no / total) * 360;
  const background = `conic-gradient(#34d399 0deg ${yesDeg}deg, #fb7185 ${yesDeg}deg ${noDeg}deg, rgba(148, 163, 184, 0.28) ${noDeg}deg 360deg)`;

  return (
    <div className="vote-pie-chart" style={{ background }}>
      <div className="vote-pie-chart-inner">
        <strong>{yes}</strong>
        <span>YES</span>
      </div>
    </div>
  );
}

function EndVoteBallotCard({ ballot }: { ballot: EndVoteBallotSnapshot }) {
  const choiceLabel = ballot.choice === "yes" ? "YES" : "NO";

  return (
    <div className={`end-vote-ballot-card ${ballot.choice === "no" ? "is-no" : "is-yes"}`}>
      <div className="end-vote-ballot-topline">
        <span className={`end-vote-choice-badge ${ballot.choice === "no" ? "is-no" : "is-yes"}`}>
          {choiceLabel}
        </span>
        <span className="end-vote-round-label">Round {ballot.round}</span>
      </div>
      <div className="end-vote-ballot-copy">
        {ballot.choice === "yes"
          ? ballot.reason || "Supports ending the session."
          : ballot.reason || "Requests more discussion before ending."}
      </div>
    </div>
  );
}

function EndVoteBoardCard({ board }: { board: EndVoteBoardSnapshot }) {
  const { yes, no } = countEndVoteChoices(board.votes, board.agentOrder);
  const pending = Math.max(board.totalAgents - yes - no, 0);
  const allReasonEntries = board.agentOrder
    .filter((agentId) => board.votes[agentId] != null)
    .map((agentId) => ({
      agentId,
      choice: board.votes[agentId]!,
      reason: board.reasons[agentId]?.trim() ?? "",
    }))
    .filter((entry) => entry.reason.length > 0);

  const statusLabel =
    board.status === "passed"
      ? "Passed"
      : board.status === "failed"
        ? "Failed"
        : board.status === "complete"
          ? "Round Complete"
          : "Voting";

  return (
    <div className={`end-vote-board-card status-${board.status}`}>
      <div className="end-vote-board-header">
        <div>
          <div className="end-vote-board-kicker">System Vote Board</div>
          <div className="end-vote-board-title">End Vote Round {board.round}</div>
        </div>
        <div className={`end-vote-board-status status-${board.status}`}>{statusLabel}</div>
      </div>

      <div className="end-vote-board-grid">
        <VotePieChart yes={yes} no={no} pending={pending} />

        <div className="end-vote-board-stats">
          <div className="end-vote-board-stat is-yes">
            <span>YES</span>
            <strong>{yes}</strong>
          </div>
          <div className="end-vote-board-stat is-no">
            <span>NO</span>
            <strong>{no}</strong>
          </div>
          <div className="end-vote-board-stat is-pending">
            <span>Pending</span>
            <strong>{pending}</strong>
          </div>
          <div className="end-vote-board-threshold">
            Requires <strong>{board.threshold}</strong> YES votes
          </div>
        </div>
      </div>

      <div className="end-vote-agent-grid">
        {board.agentOrder.map((agentId) => {
          const choice = board.votes[agentId];
          return (
            <div key={`${board.voteId}-${board.round}-${agentId}`} className="end-vote-agent-chip">
              <span className="end-vote-agent-name">{AGENT_CONFIG[agentId].name}</span>
              <span
                className={`end-vote-agent-choice ${
                  choice === "yes" ? "is-yes" : choice === "no" ? "is-no" : "is-pending"
                }`}
              >
                {choice === "yes" ? "YES" : choice === "no" ? "NO" : "Pending"}
              </span>
            </div>
          );
        })}
      </div>

      {board.outcome && <div className="end-vote-board-outcome">{board.outcome}</div>}

      {allReasonEntries.length > 0 && (
        <details className="end-vote-reasons-panel">
          <summary className="end-vote-reasons-summary">
            Show reasons ({allReasonEntries.length})
          </summary>
          <div className="end-vote-reasons-list">
            {allReasonEntries.map((entry) => (
              <div
                key={`${board.voteId}-${board.round}-reason-${entry.agentId}`}
                className="end-vote-reason-item"
              >
                <div className="end-vote-reason-agent">
                  {AGENT_CONFIG[entry.agentId].name}
                  <span
                    className={`end-vote-inline-badge ${entry.choice === "no" ? "is-no" : "is-yes"}`}
                  >
                    {entry.choice === "yes" ? "YES" : "NO"}
                  </span>
                </div>
                <div className="end-vote-reason-copy">{entry.reason}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ModeratorConclusionCard({ conclusion }: { conclusion: ModeratorConclusionSnapshot }) {
  const label =
    conclusion.status === "consensus"
      ? "Consensus"
      : conclusion.status === "majority"
        ? "Majority with Dissent"
        : "Unresolved";

  return (
    <div className={`moderator-conclusion-card status-${conclusion.status}`}>
      <div className="moderator-conclusion-topline">
        <div className={`moderator-conclusion-status status-${conclusion.status}`}>
          <StatusGlyph status={conclusion.status} />
          <span>{label}</span>
        </div>
        <div className="moderator-conclusion-score">Score {conclusion.score}/10</div>
      </div>

      <div className="moderator-conclusion-summary">{conclusion.summary}</div>

      <div className="moderator-conclusion-section">
        <div className="moderator-conclusion-label">Reason</div>
        <div className="moderator-conclusion-copy">{conclusion.reason}</div>
      </div>

      {conclusion.next && (
        <div className="moderator-conclusion-section">
          <div className="moderator-conclusion-label">Next Step</div>
          <div className="moderator-conclusion-copy">{conclusion.next}</div>
        </div>
      )}
    </div>
  );
}

const RESEARCH_PHASE_LABEL: Record<DeepResearchReportSnapshot["phase"], string> = {
  planning: "Planning sub-questions",
  research: "Reading the transcript",
  synthesis: "Synthesizing findings",
  formatting: "Writing the report",
  complete: "Report ready",
  error: "Failed",
};

function renderBodyWithCitations(
  body: string,
  citations: Array<{ id: string; messageId: string; quote: string }>,
  onCite: (messageId: string) => void,
): React.ReactNode {
  if (!body) return null;
  const citationById = new Map(citations.map((c) => [c.id, c]));
  // Split on [cN] tokens, interleave citation buttons with markdown chunks.
  const parts = body.split(/(\[c\d+\])/g);
  return (
    <>
      {parts.map((part, idx) => {
        const tokenMatch = part.match(/^\[(c\d+)\]$/);
        if (tokenMatch) {
          const cite = citationById.get(tokenMatch[1]);
          if (!cite) {
            return (
              <span key={`cite-missing-${idx}`} className="research-cite-token is-missing">
                {part}
              </span>
            );
          }
          return (
            <button
              key={`cite-${idx}-${cite.id}`}
              type="button"
              className="research-cite-token"
              title={cite.quote}
              onClick={() => onCite(cite.messageId)}
            >
              [{cite.id}]
            </button>
          );
        }
        if (!part) return null;
        return (
          <Markdown
            key={`md-${idx}`}
            content={part}
            className="research-section-body-chunk"
          />
        );
      })}
    </>
  );
}

function DeepResearchReportCard({
  report,
  onJumpToMessage,
}: {
  report: DeepResearchReportSnapshot;
  onJumpToMessage: (messageId: string) => void;
}) {
  const isInProgress =
    report.phase === "planning" ||
    report.phase === "research" ||
    report.phase === "synthesis" ||
    report.phase === "formatting";

  const phaseLabel = RESEARCH_PHASE_LABEL[report.phase] ?? report.phase;

  return (
    <details className={`deep-research-report-card phase-${report.phase}`}>
      <summary className="deep-research-report-summary">
        <div className="deep-research-report-summary-lead">
          <span className="deep-research-report-kicker">Deep Research Report</span>
          <span className="deep-research-report-title">
            {report.title || (isInProgress ? "Generating report…" : "Report")}
          </span>
        </div>
        <div className="deep-research-report-summary-meta">
          <span className={`deep-research-report-status phase-${report.phase}`}>
            {isInProgress ? (
              <>
                <span className="deep-research-spinner" aria-hidden="true" />
                {phaseLabel}…
              </>
            ) : (
              phaseLabel
            )}
          </span>
          {!isInProgress && report.phase === "complete" && (
            <span
              className={`deep-research-confidence confidence-${report.confidence}`}
              title={`Overall confidence: ${report.confidence}`}
            >
              {report.confidence}
            </span>
          )}
          <span className="deep-research-report-expand">Expand</span>
        </div>
      </summary>

      <div className="deep-research-report-body">
        {report.phase === "error" && (
          <div className="deep-research-report-error">
            Unable to generate report.
            {report.error ? <div className="deep-research-report-error-detail">{report.error}</div> : null}
          </div>
        )}

        {isInProgress && (
          <div className="deep-research-report-progress">
            <div className="deep-research-report-progress-track">
              {(["planning", "research", "synthesis", "formatting"] as const).map((phase) => (
                <div
                  key={phase}
                  className={`deep-research-report-progress-step phase-${phase} ${
                    phase === report.phase
                      ? "is-active"
                      : ["planning", "research", "synthesis", "formatting"].indexOf(phase) <
                          ["planning", "research", "synthesis", "formatting"].indexOf(report.phase)
                        ? "is-done"
                        : "is-pending"
                  }`}
                >
                  {RESEARCH_PHASE_LABEL[phase]}
                </div>
              ))}
            </div>
          </div>
        )}

        {report.abstract && (
          <p className="deep-research-report-abstract">{report.abstract}</p>
        )}

        {report.sections.length > 0 && (
          <div className="deep-research-report-sections">
            {report.sections.map((section) => (
              <section
                key={section.id}
                className={`deep-research-report-section confidence-${section.confidence}`}
              >
                <header className="deep-research-report-section-header">
                  <h4 className="deep-research-report-section-heading">{section.heading}</h4>
                  <span className={`deep-research-confidence confidence-${section.confidence}`}>
                    {section.confidence}
                  </span>
                </header>
                <div className="deep-research-report-section-body">
                  {renderBodyWithCitations(section.body, report.citations, onJumpToMessage)}
                </div>
              </section>
            ))}
          </div>
        )}

        {report.subQuestions.length > 0 && (
          <details className="deep-research-report-subquestions">
            <summary>Sub-questions explored ({report.subQuestions.length})</summary>
            <ol>
              {report.subQuestions.map((q) => (
                <li key={q.id} className={`deep-research-report-subquestion confidence-${q.confidence}`}>
                  <div className="deep-research-report-subquestion-header">
                    <span className="deep-research-report-subquestion-q">{q.question}</span>
                    <span className={`deep-research-confidence confidence-${q.confidence}`}>
                      {q.confidence}
                    </span>
                  </div>
                  {q.findings && (
                    <div className="deep-research-report-subquestion-findings">
                      {renderBodyWithCitations(q.findings, report.citations, onJumpToMessage)}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}

        {report.citations.length > 0 && (
          <details className="deep-research-report-citations">
            <summary>Citations ({report.citations.length})</summary>
            <ol>
              {report.citations.map((c) => (
                <li key={c.id} className="deep-research-report-citation">
                  <button
                    type="button"
                    className="deep-research-report-citation-button"
                    onClick={() => onJumpToMessage(c.messageId)}
                  >
                    <span className="deep-research-report-citation-id">[{c.id}]</span>
                    <span className="deep-research-report-citation-quote">
                      "{c.quote || "(no excerpt)"}"
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </details>
  );
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

function MessageAttachmentIcon({ size = 16 }: { size?: number }) {
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

function getAttachmentKindLabel(attachment: SessionAttachment) {
  switch (attachment.kind) {
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    default:
      return "File";
  }
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

function buildDiscussionOpeningMessage(topic: string): string {
  return topic.trim();
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
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
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
  const [canvasStates, setCanvasStates] = useState<Partial<Record<CouncilAgentId, CanvasState>>>(
    (normalizedSession as DiscussionSession & { canvasStates?: Partial<Record<CouncilAgentId, CanvasState>> }).canvasStates ?? {},
  );
  const canvasStatesRef = useRef(canvasStates);
  canvasStatesRef.current = canvasStates;
  const [expandedCanvases, setExpandedCanvases] = useState<Partial<Record<string, boolean>>>({});
  const [duoLogue, setDuoLogue] = useState<DuoLogueState | null>(normalizedSession.duoLogue);
  const [reactionPickerTarget, setReactionPickerTarget] = useState<string | null>(null);
  const [recentlyCopiedQuote, setRecentlyCopiedQuote] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [isTopicExpanded, setIsTopicExpanded] = useState(false);
  const [topicOverflowing, setTopicOverflowing] = useState(false);
  const [isGracefullyEnding, setIsGracefullyEnding] = useState(false);
  const [showGracefulEndConfirm, setShowGracefulEndConfirm] = useState(false);

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
  const endVoteRef = useRef<EndVoteState | null>(normalizedSession.runtime.endVote);
  const pendingHandoffRef = useRef<PendingHandoffState | null>(
    normalizedSession.runtime.pendingHandoff,
  );
  const lastPersistSignatureRef = useRef("");

  const { config, getMaxTurns, getConfiguredProviders } = useConfig();
  const maxTurns = getMaxTurns();
  const configuredProviders = getConfiguredProviders();
  const attachmentsById = useMemo(
    () => new Map(normalizedSession.attachments.map((attachment) => [attachment.id, attachment])),
    [normalizedSession.attachments],
  );
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

  const displayMessages = useMemo(() => {
    // Hide the initial system topic bubble (it duplicates the topic shown in the header)
    const firstMsg = messages[0];
    const isTopicBubble =
      firstMsg &&
      firstMsg.agentId === "system" &&
      !firstMsg.displayName &&
      !firstMsg.endVoteBoard &&
      !firstMsg.moderatorConclusion;
    return messages.filter((m) => !m.endVoteBallot && !(isTopicBubble && m === firstMsg));
  }, [messages]);

  const getMessageAttachments = useCallback(
    (message: ChatMessage) =>
      (message.attachmentIds ?? [])
        .map((attachmentId) => attachmentsById.get(attachmentId))
        .filter((attachment): attachment is SessionAttachment => Boolean(attachment)),
    [attachmentsById],
  );

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

  const loadProjectEvidenceIntoMemory = useCallback((projectId: string | null) => {
    if (!projectId || !memoryManagerRef.current) return;
    try {
      const project = loadProject(projectId);
      if (project && project.dossier.length > 0) {
        memoryManagerRef.current.setProjectEvidence(
          project.dossier.map((entry) => ({
            id: entry.attachmentId,
            name: entry.name,
            summary: entry.note || `${entry.kind.toUpperCase()} file (${entry.name})`,
          })),
        );
      }
    } catch {
      /* project may not exist */
    }
  }, []);

  const resetRuntimeState = useCallback(() => {
    costTrackerRef.current = new CostTrackerEngine(AGENT_IDS);
    setCostState(costTrackerRef.current.getState());
    memoryManagerRef.current = createMemoryManager({ windowSize: MAX_CONTEXT_MESSAGES });
    memoryManagerRef.current.setTopic(topic);
    loadProjectEvidenceIntoMemory(session.projectId);
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
    endVoteRef.current = null;
    pendingHandoffRef.current = null;
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
    loadProjectEvidenceIntoMemory(source.projectId);

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
    pendingHandoffRef.current = source.runtime.pendingHandoff;

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
        zara: 0,
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
          .filter(
            (m) =>
              (isCouncilAgent(m.agentId) || isModeratorMessage(m)) &&
              !hasStructuredVoteArtifacts(m) &&
              (m.content ?? "").trim().length > 0 &&
              !m.content.includes("[No response received]") &&
              !(m as unknown as Record<string, unknown>).error &&
              !(m as unknown as Record<string, unknown>).isStreaming,
          )
          .slice(-MAX_CONTEXT_MESSAGES);
        return {
          messages: recent,
          engagementDebts: context.engagementDebt,
          projectEvidence: context.projectEvidence,
        };
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
            !m.isStreaming &&
            !hasStructuredVoteArtifacts(m),
        )
        .slice(-MAX_CONTEXT_MESSAGES);

      return { messages: fallback, engagementDebts: [], projectEvidence: [] };
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
    (_provider: Provider, _model: string | undefined) => {
      // Raw file uploads to providers are disabled. Only code/plain-text files
      // are inlined in the prompt. PDFs, images, DOCX, XLSX and other binaries
      // appear in a compact manifest — agents must use oracle.file_search to
      // query their extracted/OCR'd content.
      const rawAttachments: APIAttachment[] = [];
      const textFileBlocks: string[] = [];
      const manifestEntries: string[] = [];

      const formatSize = (bytes: number): string => {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${bytes} B`;
      };

      for (const attachment of normalizedSession.attachments) {
        if (attachment.kind === "text") {
          // Code / plain-text files stay inlined as today.
          if (attachment.fallbackText.trim().length > 0) {
            textFileBlocks.push(attachment.fallbackText);
          }
        }

        const sizeLabel = formatSize(attachment.size);
        const dims =
          attachment.width && attachment.height
            ? `, ${attachment.width}×${attachment.height}px`
            : "";
        const indexedLabel = attachment.searchable
          ? attachment.extractedChars
            ? `indexed (~${Math.round(attachment.extractedChars / 1000)}k chars)`
            : "indexed"
          : "indexing…";
        manifestEntries.push(
          `- "${attachment.name}" (${attachment.kind}, ${attachment.mimeType}, ${sizeLabel}${dims}, ${indexedLabel})`,
        );
      }

      const notes: string[] = [];
      if (normalizedSession.attachments.length > 0) {
        notes.push(
          `Attached files (query non-code files with @tool(oracle.file_search, {"query":"..."})):\n${manifestEntries.join("\n")}`,
        );
      }
      if (textFileBlocks.length > 0) {
        notes.push(`Inlined code/text content:\n${textFileBlocks.join("\n\n")}`);
      }

      return {
        rawAttachments,
        attachmentText: notes.join("\n\n").trim(),
      };
    },
    [normalizedSession.attachments],
  );

  // Outer-circle observer agents
  const {
    observerUsage,
    runObserverPass,
    getLatestNoteFor,
    shouldRunObserverPass,
  } = useObserverCircle({
    topic,
    messagesRef,
    configRef: configRef as React.MutableRefObject<typeof config>,
    abortRef,
    buildAttachmentContext,
    agentConfig: AGENT_CONFIG,
  });

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

      const {
        messages: contextMessages,
        engagementDebts,
        projectEvidence,
      } = getContextMessages(agentId);

      if (contextMessages.length === 0) {
        const directedPrompt =
          pendingHandoffRef.current?.to === agentId
            ? `${AGENT_CONFIG[pendingHandoffRef.current.from].name} explicitly asked you to answer next.
Direct question: "${pendingHandoffRef.current.question}"
- Address this question first.
- If the question is already resolved, say that clearly before broadening the discussion.`
            : "";
        history.push({
          role: "user",
          content: [
            "You are the first speaker — there are no prior messages to quote or reference. Do NOT use @quote(...) or @react(...) in this message. State your position directly. If you need outside evidence first, emit only the @tool(...) line and stop.",
            directedPrompt,
          ]
            .filter(Boolean)
            .join("\n\n"),
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

      if (projectEvidence.length > 0) {
        const evidenceLines = projectEvidence.map((e) => `- ${e.name}: ${e.summary}`);
        history.push({
          role: "user",
          content: `## PROJECT EVIDENCE\nThe following evidence has been accumulated across sessions in this project:\n${evidenceLines.join("\n")}\nYou may reference this evidence in your response.`,
        });
      }

      if (extraContext.length > 0) {
        history.push(...extraContext);
      }

      if (pendingHandoffRef.current?.to === agentId) {
        history.push({
          role: "user",
          content: `${AGENT_CONFIG[pendingHandoffRef.current.from].name} explicitly asked you to answer next.
Direct question: "${pendingHandoffRef.current.question}"
- Address this question before broadening the discussion.
- If you think the question is based on a wrong premise, say so directly and explain why.`,
        });
      }

      // Inject latest observer note (private advice from outer-circle partner)
      const observerNote = getLatestNoteFor(agentId);
      if (observerNote) {
        history.push({
          role: "user",
          content: `[Private note from ${observerNote.observerName}]: ${observerNote.content}`,
        });
      }

      // Inject persistent canvas state so the agent can see/update prior notes
      const agentCanvas = canvasStatesRef.current[agentId];
      if (agentCanvas && agentCanvas.sections.length > 0) {
        const canvasSummary = agentCanvas.sections
          .map((s) => `## ${s.label}\n${s.text}`)
          .join("\n\n");
        history.push({
          role: "user",
          content: `[Your persistent canvas from prior turns]\n${canvasSummary}\n\nUpdate your canvas as needed before responding. Build on or revise these notes.`,
        });
      }

      history.push({
        role: "user",
        content:
          "Your turn. First, draft your key points on the canvas using @canvas(...) lines. Then, if exact wording or evidence is uncertain, use @tool(...) to search — you can output text, search, and continue writing across multiple rounds. Respond directly to one specific message above and either add one new point or narrow the group toward a decision.",
      });

      return history;
    },
    [buildAttachmentContext, buildEngagementPrompt, getContextMessages, getLatestNoteFor, topic],
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
            !message.isStreaming &&
            !hasStructuredVoteArtifacts(message),
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
        content: `The discussion phase has ended after ${turnsCompleted} turns. You are now in the closing round.
- Start with a short title on its own line (3–6 words, no punctuation, no dashes). This is the headline of your closing reflection.
- Then write 2–4 sentences summarizing the conclusion or recommendation you stand by.
- Give the strongest supporting reason in one short clause.
- End with a short goodbye or sign-off line to the group.
- Do NOT ask any questions.
- Do NOT include @quote(...), @react(...), @tool(...), @vote(...), or @end().
- Do NOT introduce a brand-new topic.`,
      });

      return history;
    },
    [buildAttachmentContext, topic],
  );

  const buildEndVoteConversationHistory = useCallback(
    (agentId: CouncilAgentId, voteState: EndVoteState): APIChatMessage[] => {
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
      const threshold = getEndVoteThreshold(configuredAgentIds);
      const firstRoundCount = countEndVoteChoices(voteState.firstRoundVotes, configuredAgentIds);
      const firstRoundObjections = configuredAgentIds
        .filter((candidateId) => voteState.firstRoundVotes[candidateId] === "no")
        .map((candidateId) => {
          const reason = voteState.firstRoundReasons[candidateId]?.trim();
          return reason ? `- ${AGENT_CONFIG[candidateId].name}: ${reason}` : null;
        })
        .filter((entry): entry is string => Boolean(entry));

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
        content:
          voteState.round === 1
            ? `${AGENT_CONFIG[voteState.proposer].name} moved to end the session now. This is end-vote round 1 of 2.
- The motion currently includes ${AGENT_CONFIG[voteState.proposer].name}'s YES vote, so the tally starts at YES ${firstRoundCount.yes}/${configuredAgentIds.length}, NO ${firstRoundCount.no}/${configuredAgentIds.length}.
- Write 1-3 short sentences total.
- Your first visible sentence must start exactly with Vote: YES or Vote: NO.
- If you vote NO, you must state one concrete reason the discussion should continue.
- If you vote YES, briefly state why the room is ready to stop.
- Do NOT ask a question.
- Do NOT include @quote(...), @react(...), @tool(...), or @end().
- End by appending exactly one standalone line: @vote(end, yes) or @vote(end, no).`
            : `Round 1 of the end vote is complete. This is round 2 of 2 and it decides the result.
- Round 1 tally was YES ${firstRoundCount.yes}/${configuredAgentIds.length}, NO ${firstRoundCount.no}/${configuredAgentIds.length}.
- Round 1 objections:
${firstRoundObjections.length > 0 ? firstRoundObjections.join("\n") : "- None. Everyone supported ending."}
- The motion passes only if at least ${threshold} of ${configuredAgentIds.length} council agents vote YES in round 2.
- Write 1-3 short sentences total.
- Your first visible sentence must start exactly with Vote: YES or Vote: NO.
- If you vote NO, you must state one concrete reason the discussion should continue.
- If you vote YES, briefly state why the room is ready to stop.
- Do NOT ask a question.
- Do NOT include @quote(...), @react(...), @tool(...), or @end().
- End by appending exactly one standalone line: @vote(end, yes) or @vote(end, no).`,
      });

      return history;
    },
    [buildAttachmentContext, configuredAgentIds, topic],
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
    const credential = config.credentials.google;
    if (!credential?.apiKey) return null;
    // Moderator runs on Gemini 3.1 Pro Preview (same model Grace uses).
    return {
      provider: "google" as const,
      credential,
      model: "gemini-3.1-pro-preview" as const,
    };
  }, [config.credentials.google, config.preferences.moderatorEnabled]);

  const pickFinalSummaryRuntime = useCallback(() => {
    // Prefer Google (same as moderator) so final summary + deep research report
    // run on the same provider.
    const googleCredential = config.credentials.google;
    if (googleCredential?.apiKey) {
      return {
        provider: "google" as const,
        credential: googleCredential,
        model: "gemini-3.1-pro-preview" as const,
      };
    }

    for (const provider of [
      "openai",
      "anthropic",
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
      if (options.kind !== "final_summary" && !config.preferences.moderatorEnabled) {
        return null;
      }
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

        let history: APIChatMessage[] = [
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
Write a concise moderator note that moves the council into the closing round:
- tell them the next step is to wrap up instead of extending the debate,
- instruct each agent to summarize their conclusion in a few sentences and end with a short goodbye,
- do not leave the room with another open-ended question,
- do not use @vote(...), or @end().`,
          });
        } else if (options.kind === "final_summary") {
          history.push({
            role: "user",
            content: `The closing round is complete after ${options.turn ?? "the discussion"} turns.
Write the official moderator wrap-up in 4 short sentences:
- The first sentence must start with exactly one of these labels: Consensus:, Majority with dissent:, or Unresolved:.
- State the council's final recommendation or the blocking issue in plain language.
- The second sentence must be exactly: Score: X/10. Replace X with an integer from 0 to 10.
- The third sentence must explain in plain language why the discussion earned that score, including the main dissent or uncertainty.
- End with the next action, test, or evidence that matters most.
- Do NOT ask a question.`,
          });
        }

        let result = await callProvider(
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

        // Moderator is instructed NOT to use @quote/@react/@tool/@end, so skip
        // extractActions to avoid accidentally stripping content that matches
        // those patterns (e.g. parenthetical asides, dollar signs, etc.).
        // Still strip @canvas directives defensively (very specific pattern, no false positives).
        let displayContent = normalizeMessageText(
          extractCanvasDirectives(result.content || streamingContent || "").cleaned,
        );
        let moderatorConclusion =
          options.kind === "final_summary"
            ? parseModeratorConclusionFromText(displayContent)
            : null;

        if (options.kind === "final_summary" && result.success && !moderatorConclusion) {
          history = [
            ...history,
            {
              role: "assistant",
              content: displayContent || "[No response received]",
            },
            {
              role: "user",
              content:
                "You did not follow the required 4-sentence format. Reply again now with exactly these lines: 1) Consensus:/Majority with dissent:/Unresolved: plus the plain-language outcome. 2) Score: X/10. 3) One sentence explaining the score. 4) One sentence naming the next action, test, or evidence.",
            },
          ];
          streamingContent = "";
          streamingThinking = "";

          result = await callProvider(
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

          displayContent = normalizeMessageText(
            extractCanvasDirectives(result.content || streamingContent || "").cleaned,
          );
          moderatorConclusion = parseModeratorConclusionFromText(displayContent);
        }

        const finalVisibleContent =
          displayContent ||
          (moderatorConclusion ? buildModeratorConclusionContent(moderatorConclusion) : "");

        const finalMessage: ChatMessage = {
          ...newMessage,
          content: finalVisibleContent || "[No response received]",
          isStreaming: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          error: result.error,
          thinking: result.thinking || streamingThinking || undefined,
          fullResponse: finalVisibleContent || undefined,
          moderatorConclusion: moderatorConclusion ?? undefined,
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

        // Kick off the Deep Research Report for the final summary. This runs
        // asynchronously and updates the message's deepResearchReport field as
        // it progresses through planning → research → synthesis → formatting.
        if (
          options.kind === "final_summary" &&
          result.success &&
          moderatorConclusion &&
          provider === "google"
        ) {
          const transcript: DeepResearchTranscriptMessage[] = messagesRef.current
            .filter((msg) => {
              if (msg.isStreaming) return false;
              if (msg.endVoteBallot || msg.endVoteBoard) return false;
              if (!isCouncilAgent(msg.agentId) && !isModeratorMessage(msg)) return false;
              const text = (msg.content ?? "").trim();
              return text.length > 0;
            })
            .map((msg) => ({
              id: msg.id,
              speaker: isCouncilAgent(msg.agentId)
                ? AGENT_CONFIG[msg.agentId].name
                : "Moderator",
              text: msg.content ?? "",
            }));

          const updateReport = (report: DeepResearchReportSnapshot) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === newMessage.id
                  ? { ...m, deepResearchReport: report }
                  : m,
              ),
            );
          };

          // Initial placeholder so UI renders a loading card immediately.
          updateReport({
            phase: "planning",
            title: "",
            abstract: "",
            subQuestions: [],
            sections: [],
            citations: [],
            confidence: "medium",
            generatedAt: Date.now(),
            modelId: model,
          });

          // Fire-and-forget — the moderator message is already committed.
          void (async () => {
            try {
              const report = await generateDeepResearchReport({
                provider,
                credential,
                model,
                proxy,
                topic,
                transcript,
                conclusion: moderatorConclusion!,
                onPhase: (_phase, partial) => updateReport(partial),
              });
              updateReport(report);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              updateReport({
                phase: "error",
                title: "",
                abstract: "",
                subQuestions: [],
                sections: [],
                citations: [],
                confidence: "low",
                generatedAt: Date.now(),
                modelId: model,
                error: message,
              });
            }
          })();
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
      let firstContentAt: number | null = null;
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
          let canvasDirectivesApplied = 0;

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
                if (!firstContentAt) firstContentAt = Date.now();
                const detection = streamingToolDetector.push(chunk.content);
                if (detection.toolCalls.length > 0) {
                  streamedToolCalls.push(...detection.toolCalls);
                  interruptedForTools = true;
                  clearStreamFlushTimer();
                  flushStreamingMessage(true);
                  requestController.abort();
                  return;
                }
                // Use proper brace-depth parser to strip canvas directives (handles multi-line)
                const { cleaned: canvasCleaned, directives: canvasDirectives } =
                  extractCanvasDirectives(detection.visibleText);
                let displayText = canvasCleaned
                  .replace(/^[ \t]*@done\(\)[ \t]*$/gm, "")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
                // Hide partial @canvas( still being streamed (incomplete directive)
                const partialIdx = displayText.lastIndexOf("@canvas(");
                if (partialIdx >= 0 && !displayText.slice(partialIdx).includes(")")) {
                  displayText = displayText.slice(0, partialIdx).replace(/\n{3,}/g, "\n\n").trim();
                }
                streamingContent = displayText;
                // Apply only NEW canvas directives (cumulative text re-parses old ones)
                for (let ci = canvasDirectivesApplied; ci < canvasDirectives.length; ci++) {
                  const directive = canvasDirectives[ci]!;
                  setCanvasStates((prev) => ({
                    ...prev,
                    [agentId]: applyCanvasDirective(prev[agentId], directive, agentId, currentTurnRef.current),
                  }));
                }
                canvasDirectivesApplied = canvasDirectives.length;
              }
              if (chunk.thinking) {
                streamingThinking += chunk.thinking;
              }
              if (chunk.done) {
                if (!interruptedForTools) {
                  const toolFinished = streamingToolDetector.finish();
                  const { cleaned: finalCleaned, directives: finalDirectives } =
                    extractCanvasDirectives(toolFinished);
                  streamingContent = finalCleaned
                    .replace(/^[ \t]*@done\(\)[ \t]*$/gm, "")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();
                  for (let ci = canvasDirectivesApplied; ci < finalDirectives.length; ci++) {
                    const directive = finalDirectives[ci]!;
                    setCanvasStates((prev) => ({
                      ...prev,
                      [agentId]: applyCanvasDirective(prev[agentId], directive, agentId, currentTurnRef.current),
                    }));
                  }
                  canvasDirectivesApplied = finalDirectives.length;
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

          const rawForVisible = interruptedForTools
            ? streamingToolDetector.getVisibleText()
            : providerResult.content || "";
          const { cleaned: canvasStrippedForVisible } = extractCanvasDirectives(rawForVisible);
          const parsedVisible = interruptedForTools
            ? normalizeMessageText(canvasStrippedForVisible)
            : extractActions(canvasStrippedForVisible, REACTION_IDS).cleaned;
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
        let accumulatedContent = "";

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

        // Accumulate visible content from the initial completion
        if (result.content) {
          accumulatedContent = result.content;
        }

        while (result.success && toolIteration < MAX_TOOL_ITERATIONS) {
          const rawForParsing = result.rawContent || result.content || "";
          const parsedForTools = extractActions(rawForParsing, REACTION_IDS);
          const canvasFromRound = extractCanvasDirectives(rawForParsing);
          const toolCalls =
            result.streamedToolCalls.length > 0
              ? result.streamedToolCalls
              : parsedForTools.toolCalls;

          // Apply canvas directives from this round immediately
          for (const directive of canvasFromRound.directives) {
            setCanvasStates((prev) => ({
              ...prev,
              [agentId]: applyCanvasDirective(prev[agentId], directive, agentId, currentTurnRef.current),
            }));
          }

          // Agent is done if it emitted @done() or @end(), or has no work indicators
          const hasWorkIndicators = toolCalls.length > 0 || canvasFromRound.directives.length > 0;
          if (parsedForTools.doneRequested || parsedForTools.endRequested || !hasWorkIndicators) break;

          const interim =
            accumulatedContent ||
            parsedForTools.cleaned ||
            (toolIteration === 0 ? "Researching sources..." : "Gathering more context...");
          setMessages((prev) =>
            prev.map((m) => (m.id === newMessage.id ? { ...m, content: interim, toolEvents } : m)),
          );

          // Execute tool calls if any
          if (toolCalls.length > 0) {
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

            // Include the agent's prior output as assistant message so it can continue naturally
            const extraContext = buildToolContextMessages(results);
            const priorAssistant = accumulatedContent.trim();
            if (priorAssistant) {
              history = buildConversationHistory(agentId, [
                { role: "assistant", content: priorAssistant },
                ...extraContext,
              ]);
            } else {
              history = buildConversationHistory(agentId, extraContext);
            }
          } else {
            // Canvas-only round (no tools): continue with a continuation prompt
            const priorAssistant = accumulatedContent.trim();
            history = buildConversationHistory(agentId, [
              ...(priorAssistant ? [{ role: "assistant" as const, content: priorAssistant }] : []),
              {
                role: "user" as const,
                content: "Continue your response. When you are finished, emit @done() on its own line.",
              },
            ]);
          }

          result = await runCompletion(history, modelUsed);
          toolIteration += 1;

          // Accumulate new content from this completion
          const newContent = (result.content || "").trim();
          if (newContent) {
            accumulatedContent = accumulatedContent
              ? accumulatedContent + "\n\n" + newContent
              : newContent;
            streamingContent = accumulatedContent;
            flushStreamingMessage(true);
          }
        }

        // Strip canvas directives from the final content
        const canvasFromFinal = extractCanvasDirectives(result.rawContent || result.content || "");
        for (const directive of canvasFromFinal.directives) {
          setCanvasStates((prev) => ({
            ...prev,
            [agentId]: applyCanvasDirective(prev[agentId], directive, agentId, currentTurnRef.current),
          }));
        }

        let parsed = extractActions(canvasFromFinal.cleaned, REACTION_IDS);

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

        const { cleaned: accCanvasCleaned } = extractCanvasDirectives(accumulatedContent || result.content || streamingContent || "");
        const finalVisibleContent = normalizeMessageText(accCanvasCleaned);
        const resolvedQuotes = resolveQuoteTargets(agentId, parsed.quoteTargets);
        const parsedReactions = parsed.reactions.map((reaction) => ({
          targetId: reaction.targetId,
          emoji: reaction.emoji as ReactionId,
        }));
        const resolvedReactions =
          parsedReactions.length === 0 && resolvedQuotes.length > 0
            ? [{ targetId: resolvedQuotes[0]!, emoji: DEFAULT_REACTION }]
            : parsedReactions;
        const initialDisplayContent = stripProviderToolSyntax(
          finalVisibleContent ||
          parsed.cleaned ||
          (parsed.endRequested ? "I think we're ready to wrap this up." : "") ||
          (toolEvents.length > 0
            ? "Research completed, but no final answer was generated."
            : "[No response received]"),
        );
        const { cleaned: strippedDisplayContent, handoff } = extractHandoffDirective({
          raw: initialDisplayContent,
          from: agentId,
          validAgents: AGENT_IDS,
          normalizeMessageText,
        });
        const handoffForNextTurn =
          result.success && !result.error && handoff && !parsed.endRequested
            ? {
                ...handoff,
                sourceMessageId: newMessage.id,
                timestamp: Date.now(),
              }
            : null;
        const displayContent =
          strippedDisplayContent ||
          (parsed.endRequested ? "I think we're ready to wrap this up." : "") ||
          (toolEvents.length > 0
            ? "Research completed, but no final answer was generated."
            : "[No response received]");

        const finalMessage: ChatMessage = {
          ...newMessage,
          content: displayContent,
          thinking: result.thinking || streamingThinking || undefined,
          thinkingMs: firstContentAt ? firstContentAt - newMessage.timestamp : undefined,
          fullResponse: displayContent || undefined,
          isStreaming: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          error: result.error,
          toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
          requestedEnd: parsed.endRequested || undefined,
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

        if (handoffForNextTurn) {
          pendingHandoffRef.current = handoffForNextTurn;
          setMessages((prev) => [
            ...prev,
            {
              id: `msg_${Date.now()}_${agentId}_handoff_notice`,
              agentId: "system",
              content: `${AGENT_CONFIG[agentId].name} directed the next reply to ${AGENT_CONFIG[handoffForNextTurn.to].name}: ${handoffForNextTurn.question}`,
              timestamp: Date.now(),
            },
          ]);
        }

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
        isResolution: true,
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

        const { cleaned: resCanvasCleaned } = extractCanvasDirectives(result.content || "");
        const { cleaned } = extractActions(resCanvasCleaned, REACTION_IDS);
        const displayContent =
          cleaned || normalizeMessageText(
            extractCanvasDirectives(result.content || streamingContent || "").cleaned,
          );

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

  const generateEndVoteResponse = useCallback(
    async (
      agentId: CouncilAgentId,
      voteState: EndVoteState,
    ): Promise<{ message: ChatMessage | null; choice: EndVoteChoice | null; reason: string }> => {
      if (abortRef.current) return { message: null, choice: null, reason: "" };

      const agentConfig = AGENT_CONFIG[agentId];
      const credential = config.credentials[agentConfig.provider];
      const model = config.models[agentConfig.provider];

      if (!credential?.apiKey || !model) {
        return { message: null, choice: "no", reason: "" };
      }

      const proxy = getProxy();
      const controller = new AbortController();
      activeRequestsRef.current.set(agentId, controller);
      setTypingAgents((prev) => (prev.includes(agentId) ? prev : [...prev, agentId]));

      const newMessage: ChatMessage = {
        id: `msg_${Date.now()}_${agentId}_end_vote_${voteState.round}`,
        agentId,
        content: "",
        timestamp: Date.now(),
        isStreaming: true,
        metadata: { model: model as ModelId, latencyMs: 0 },
      };

      setMessages((prev) => [...prev, newMessage]);

      let streamingContent = "";
      let streamingRawContent = "";
      let streamingThinking = "";
      try {
        let history = buildEndVoteConversationHistory(agentId, voteState);
        let result = await callProvider(
          agentConfig.provider,
          credential,
          model,
          history,
          (chunk) => {
            if (abortRef.current) return;
            if (chunk.content) {
              streamingRawContent += chunk.content;
              streamingContent = stripLegacyEndVoteDirective(streamingRawContent).cleaned;
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
            idleTimeoutMs: 60000,
            requestTimeoutMs: 90000,
          },
        );

        if (abortRef.current) {
          setMessages((prev) => prev.filter((m) => m.id !== newMessage.id));
          return { message: null, choice: null, reason: "" };
        }

        let voteExtraction = stripLegacyEndVoteDirective(
          extractCanvasDirectives(result.content || streamingRawContent || "").cleaned,
        );
        let displayContent =
          voteExtraction.cleaned ||
          normalizeMessageText(
            extractCanvasDirectives(result.content || streamingRawContent || streamingContent || "").cleaned,
          );
        let voteChoice =
          voteExtraction.voteChoice ?? parseVoteChoiceFromVisibleText(displayContent);
        let voteReason = extractVoteReasonFromVisibleText(voteChoice, displayContent);
        let hasReason = hasRequiredVoteReason(voteChoice, voteReason);

        if (result.success && !voteChoice) {
          history = [
            ...history,
            {
              role: "assistant",
              content: displayContent || "[No response received]",
            },
            {
              role: "user",
              content:
                "You did not cast a valid end vote. Reply again now. Your first visible sentence must start exactly with Vote: YES or Vote: NO. If you vote NO, you must give one concrete reason to continue. End with exactly one standalone line: @vote(end, yes) or @vote(end, no).",
            },
          ];
          streamingContent = "";
          streamingRawContent = "";
          streamingThinking = "";
          result = await callProvider(
            agentConfig.provider,
            credential,
            model,
            history,
            (chunk) => {
              if (abortRef.current) return;
              if (chunk.content) {
                streamingRawContent += chunk.content;
                streamingContent = stripLegacyEndVoteDirective(streamingRawContent).cleaned;
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
              idleTimeoutMs: 60000,
              requestTimeoutMs: 90000,
            },
          );

          if (abortRef.current) {
            setMessages((prev) => prev.filter((m) => m.id !== newMessage.id));
            return { message: null, choice: null, reason: "" };
          }

          voteExtraction = stripLegacyEndVoteDirective(
            extractCanvasDirectives(result.content || streamingRawContent || "").cleaned,
          );
          displayContent =
            voteExtraction.cleaned ||
            normalizeMessageText(
              extractCanvasDirectives(result.content || streamingRawContent || streamingContent || "").cleaned,
            );
          voteChoice = voteExtraction.voteChoice ?? parseVoteChoiceFromVisibleText(displayContent);
          voteReason = extractVoteReasonFromVisibleText(voteChoice, displayContent);
          hasReason = hasRequiredVoteReason(voteChoice, voteReason);
        }

        if (!voteChoice || !hasReason) {
          voteChoice = "no";
          voteReason =
            "I am not ready to end because I did not provide a valid ballot with a clear reason to stop.";
          displayContent = "";
        }

        const ballot: EndVoteBallotSnapshot = {
          voteId: voteState.id,
          round: voteState.round,
          choice: voteChoice,
          ...(voteReason ? { reason: voteReason } : {}),
        };
        const finalVisibleContent = displayContent || buildEndVoteBallotContent(ballot);

        const finalMessage: ChatMessage = {
          ...newMessage,
          content: finalVisibleContent || "[No response received]",
          thinking: result.thinking || streamingThinking || undefined,
          fullResponse: finalVisibleContent || undefined,
          isStreaming: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          error: result.error,
          endVoteBallot: ballot,
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
        } else {
          setErrors((prev) => [...prev, result.error || "Unknown error"]);
        }

        return { message: finalMessage, choice: voteChoice, reason: voteReason };
      } finally {
        activeRequestsRef.current.delete(agentId);
        setTypingAgents((prev) => prev.filter((id) => id !== agentId));
      }
    },
    [buildEndVoteConversationHistory, config, getProxy],
  );

  const buildEndVoteBoard = useCallback(
    (
      voteState: EndVoteState,
      status: EndVoteBoardSnapshot["status"],
      outcome?: string,
    ): EndVoteBoardSnapshot => ({
      voteId: voteState.id,
      proposer: voteState.proposer,
      round: voteState.round,
      threshold: getEndVoteThreshold(configuredAgentIds),
      totalAgents: configuredAgentIds.length,
      agentOrder: [...configuredAgentIds],
      votes: {
        ...(voteState.round === 1 ? voteState.firstRoundVotes : voteState.secondRoundVotes),
      },
      reasons: {
        ...(voteState.round === 1 ? voteState.firstRoundReasons : voteState.secondRoundReasons),
      },
      status,
      ...(outcome ? { outcome } : {}),
    }),
    [configuredAgentIds],
  );

  const upsertEndVoteBoardMessage = useCallback((board: EndVoteBoardSnapshot) => {
    const content = buildEndVoteBoardContent(board);

    setMessages((prev) => {
      const existingIndex = prev.findIndex(
        (message) =>
          message.agentId === "system" &&
          message.endVoteBoard?.voteId === board.voteId &&
          message.endVoteBoard?.round === board.round,
      );

      if (existingIndex === -1) {
        return [
          ...prev,
          {
            id: `msg_${Date.now()}_${board.voteId}_vote_board_${board.round}`,
            agentId: "system",
            content,
            timestamp: Date.now(),
            endVoteBoard: board,
          },
        ];
      }

      const next = [...prev];
      const current = next[existingIndex]!;
      next[existingIndex] = {
        ...current,
        content,
        endVoteBoard: board,
      };
      return next;
    });
  }, []);

  const beginEndVote = useCallback(
    (proposer: CouncilAgentId) => {
      const threshold = getEndVoteThreshold(configuredAgentIds);
      const voteState: EndVoteState = {
        id: `end_vote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        proposer,
        round: 1,
        queue: configuredAgentIds.filter((agentId) => agentId !== proposer),
        firstRoundVotes: { [proposer]: "yes" },
        firstRoundReasons: {},
        secondRoundVotes: {},
        secondRoundReasons: {},
      };
      endVoteRef.current = voteState;
      pendingHandoffRef.current = null;
      setDuoLogue(null);
      duoLogueRef.current = null;
      setConflictState(null);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_${Date.now()}_end_vote_round_1_notice`,
          agentId: "system",
          content: `${AGENT_CONFIG[proposer].name} requested to end the session. End vote round 1 of 2 begins now. The other ${Math.max(configuredAgentIds.length - 1, 0)} agents must vote YES or NO, and any NO vote must state a reason. If every agent votes YES in round 1, round 2 is unnecessary and the council will move straight to the conclusion. Otherwise, round 2 will make the final decision, and ending requires at least ${threshold} YES votes.`,
          timestamp: Date.now(),
        },
      ]);
      upsertEndVoteBoardMessage(buildEndVoteBoard(voteState, "active"));
    },
    [buildEndVoteBoard, configuredAgentIds, upsertEndVoteBoardMessage],
  );

  const continueEndVote = useCallback(async () => {
    const voteState = endVoteRef.current;
    if (!voteState || abortRef.current) return;

    const threshold = getEndVoteThreshold(configuredAgentIds);
    const nextAgent = voteState.queue[0];

    if (nextAgent) {
      const { choice, reason } = await generateEndVoteResponse(nextAgent, voteState);
      if (abortRef.current) return;

      const safeChoice = choice ?? "no";
      const nextVoteState: EndVoteState =
        voteState.round === 1
          ? {
              ...voteState,
              queue: voteState.queue.slice(1),
              firstRoundVotes: {
                ...voteState.firstRoundVotes,
                [nextAgent]: safeChoice,
              },
              firstRoundReasons: {
                ...voteState.firstRoundReasons,
                ...(reason ? { [nextAgent]: reason } : {}),
              },
            }
          : {
              ...voteState,
              queue: voteState.queue.slice(1),
              secondRoundVotes: {
                ...voteState.secondRoundVotes,
                [nextAgent]: safeChoice,
              },
              secondRoundReasons: {
                ...voteState.secondRoundReasons,
                ...(reason ? { [nextAgent]: reason } : {}),
              },
            };

      endVoteRef.current = nextVoteState;
      upsertEndVoteBoardMessage(
        buildEndVoteBoard(nextVoteState, nextVoteState.queue.length === 0 ? "complete" : "active"),
      );
      cyclePendingRef.current = cyclePendingRef.current.filter((agentId) => agentId !== nextAgent);
      previousSpeakerRef.current = nextAgent;
      fairnessManagerRef.current.recordSpeaker(nextAgent);
      recentSpeakersRef.current = [...recentSpeakersRef.current.slice(-5), nextAgent];
      currentTurnRef.current += 1;
      setCurrentTurn(currentTurnRef.current);
      return;
    }

    if (voteState.round === 1) {
      const firstRoundCount = countEndVoteChoices(voteState.firstRoundVotes, configuredAgentIds);
      if (firstRoundCount.yes === configuredAgentIds.length && firstRoundCount.no === 0) {
        const unanimousOutcome = `All ${configuredAgentIds.length} agents voted YES in round 1, so round 2 was skipped.`;
        upsertEndVoteBoardMessage(buildEndVoteBoard(voteState, "passed", unanimousOutcome));
        endVoteRef.current = null;

        beginClosingRound(
          `End vote passed unanimously in round 1 by ${firstRoundCount.yes}-${firstRoundCount.no}. Round 2 is unnecessary and was therefore skipped. The council moves straight to closing summaries and the Moderator's final report.`,
        );
        return;
      }

      upsertEndVoteBoardMessage(
        buildEndVoteBoard(
          voteState,
          "complete",
          "Round 2 is required because not every agent approved ending in round 1.",
        ),
      );
      const roundTwoState: EndVoteState = {
        ...voteState,
        round: 2,
        queue: [...configuredAgentIds],
        secondRoundVotes: {},
        secondRoundReasons: {},
      };
      endVoteRef.current = roundTwoState;
      upsertEndVoteBoardMessage(buildEndVoteBoard(roundTwoState, "active"));
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_${Date.now()}_end_vote_round_2_notice`,
          agentId: "system",
          content: `End vote round 1 is complete. Tally: YES ${firstRoundCount.yes}/${configuredAgentIds.length}, NO ${firstRoundCount.no}/${configuredAgentIds.length}. Round 2 of 2 begins now and determines the result. All ${configuredAgentIds.length} agents must vote, and the motion passes only if at least ${threshold} vote YES.`,
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    const finalCount = countEndVoteChoices(voteState.secondRoundVotes, configuredAgentIds);
    const passed = finalCount.yes >= threshold;
    upsertEndVoteBoardMessage(
      buildEndVoteBoard(
        voteState,
        passed ? "passed" : "failed",
        passed
          ? `End vote passed in round 2 by ${finalCount.yes}-${finalCount.no}.`
          : `End vote failed in round 2 by ${finalCount.yes}-${finalCount.no}.`,
      ),
    );
    endVoteRef.current = null;

    if (passed) {
      beginClosingRound(
        `End vote passed in round 2 by ${finalCount.yes}-${finalCount.no}. Closing round: each agent gives a short summary and goodbye, then the Moderator publishes the final summary, score, and explanation.`,
      );
      return;
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}_end_vote_failed`,
        agentId: "system",
        content: `End vote failed in round 2 by ${finalCount.yes}-${finalCount.no}. At least ${threshold} YES votes were required, so the discussion will continue.`,
        timestamp: Date.now(),
      },
    ]);

    if (cyclePendingRef.current.length === 0) {
      cyclePendingRef.current = [...configuredAgentIds];
    }
  }, [buildEndVoteBoard, configuredAgentIds, generateEndVoteResponse, upsertEndVoteBoardMessage]);

  const beginClosingRound = useCallback(
    (notice: string) => {
      phaseRef.current = "resolution";
      pausedRef.current = false;
      setIsPaused(false);
      endVoteRef.current = null;
      pendingHandoffRef.current = null;
      setDuoLogue(null);
      duoLogueRef.current = null;
      setConflictState(null);
      resolutionQueueRef.current = [...configuredAgentIds];
      moderatorResolutionPromptPostedRef.current = true;

      if (!resolutionNoticePostedRef.current) {
        resolutionNoticePostedRef.current = true;
        setMessages((prev) => [
          ...prev,
          {
            id: `msg_${Date.now()}_resolution_notice`,
            agentId: "system",
            content: notice,
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [configuredAgentIds],
  );

  // Main discussion loop
  const runDiscussion = useCallback(
    async (mode: "fresh" | "resume" = "resume") => {
      if (mode === "fresh") {
        resetRuntimeState();

        const topicMessage: ChatMessage = {
          id: `msg_${Date.now()}`,
          agentId: "system",
          content: buildDiscussionOpeningMessage(topic),
          attachmentIds:
            normalizedSession.attachments.length > 0
              ? normalizedSession.attachments.map((attachment) => attachment.id)
              : undefined,
          timestamp: Date.now(),
        };

        setMessages([topicMessage]);
        cyclePendingRef.current = [...configuredAgentIds];
      } else {
        if (phaseRef.current === "completed") {
          return;
        }

        if (phaseRef.current === "discussion") {
          if (
            pendingHandoffRef.current &&
            (!configuredAgentIds.includes(pendingHandoffRef.current.from) ||
              !configuredAgentIds.includes(pendingHandoffRef.current.to))
          ) {
            pendingHandoffRef.current = null;
          }

          if (endVoteRef.current) {
            if (!configuredAgentIds.includes(endVoteRef.current.proposer)) {
              endVoteRef.current = null;
            } else {
              const filterVotes = (votes: EndVoteChoiceMap): EndVoteChoiceMap =>
                Object.fromEntries(
                  Object.entries(votes).filter(([agentId]) =>
                    configuredAgentIds.includes(agentId as CouncilAgentId),
                  ),
                ) as EndVoteChoiceMap;
              const filterReasons = (reasons: EndVoteReasonMap): EndVoteReasonMap =>
                Object.fromEntries(
                  Object.entries(reasons).filter(([agentId]) =>
                    configuredAgentIds.includes(agentId as CouncilAgentId),
                  ),
                ) as EndVoteReasonMap;

              endVoteRef.current = {
                ...endVoteRef.current,
                queue: endVoteRef.current.queue.filter((id) => configuredAgentIds.includes(id)),
                firstRoundVotes: filterVotes(endVoteRef.current.firstRoundVotes),
                firstRoundReasons: filterReasons(endVoteRef.current.firstRoundReasons),
                secondRoundVotes: filterVotes(endVoteRef.current.secondRoundVotes),
                secondRoundReasons: filterReasons(endVoteRef.current.secondRoundReasons),
              };
            }
          }

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
        (Boolean(endVoteRef.current) || maxTurns === Infinity || currentTurnRef.current < maxTurns)
      ) {
        if (endVoteRef.current) {
          await continueEndVote();
          if (abortRef.current || phaseRef.current !== "discussion") {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }

        const pending = cyclePendingRef.current.filter((id) => configuredAgentIds.includes(id));
        cyclePendingRef.current = pending.length > 0 ? pending : [...configuredAgentIds];
        const pendingNow = cyclePendingRef.current;
        const directedHandoff = pendingHandoffRef.current;
        let selectedSpeaker: CouncilAgentId | undefined;
        let consumedHandoff: PendingHandoffState | null = null;

        if (
          directedHandoff &&
          configuredAgentIds.includes(directedHandoff.to) &&
          configuredProviders.includes(AGENT_CONFIG[directedHandoff.to].provider) &&
          pendingNow.includes(directedHandoff.to)
        ) {
          selectedSpeaker = directedHandoff.to;
          consumedHandoff = directedHandoff;
          setCurrentBidding(null);
          setShowBidding(false);
        } else if (directedHandoff) {
          pendingHandoffRef.current = null;
        }

        if (!selectedSpeaker) {
          const focusAgents = duoLogueRef.current?.remainingTurns
            ? duoLogueRef.current.participants
            : undefined;
          const excludeForRound =
            pendingNow.length > 1 ? (previousSpeakerRef.current ?? undefined) : undefined;
          const bidding = generateBiddingScores(
            excludeForRound,
            AGENT_IDS,
            focusAgents,
            pendingNow,
          );

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

          selectedSpeaker = rankedAgents[0];
        }

        if (!selectedSpeaker) {
          break;
        }

        let response = await generateAgentResponse(selectedSpeaker);
        if ((!response || response.error) && !abortRef.current) {
          response = await generateAgentResponse(selectedSpeaker);
        }
        if (
          consumedHandoff &&
          pendingHandoffRef.current?.sourceMessageId === consumedHandoff.sourceMessageId
        ) {
          pendingHandoffRef.current = null;
        }
        if (abortRef.current) break;

        const actualSpeaker: CouncilAgentId | null =
          response && !response.error ? selectedSpeaker : null;

        if (consumedHandoff && !actualSpeaker) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }

        cyclePendingRef.current = cyclePendingRef.current.filter((id) => id !== selectedSpeaker);
        if (actualSpeaker) {
          previousSpeakerRef.current = actualSpeaker;
          fairnessManagerRef.current.recordSpeaker(actualSpeaker);
          recentSpeakersRef.current = [...recentSpeakersRef.current.slice(-5), actualSpeaker];
        }

        currentTurnRef.current += 1;
        setCurrentTurn(currentTurnRef.current);

        if (actualSpeaker && response?.requestedEnd) {
          beginEndVote(actualSpeaker);
        }

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

        if (actualSpeaker && response?.requestedEnd) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
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

        // Fire outer-circle observer pass (non-blocking)
        if (!abortRef.current && shouldRunObserverPass(currentTurnRef.current)) {
          runObserverPass(currentTurnRef.current, (observerMsgs) => {
            setMessages((prev) => [...prev, ...(observerMsgs as ChatMessage[])]);
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (
        !abortRef.current &&
        phaseRef.current === "discussion" &&
        currentTurnRef.current > 0 &&
        !endVoteRef.current
      ) {
        beginClosingRound(
          `Discussion phase ended after ${currentTurnRef.current} turns. Closing round: each agent gives a short summary and goodbye, then the Moderator publishes the final summary, score, and explanation.`,
        );
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
                "Moderator summary unavailable because no summary provider is configured. Review the closing round above for the final agent summaries and goodbyes.",
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
      beginEndVote,
      continueEndVote,
      generateAgentResponse,
      generateModeratorMessage,
      generateResolutionResponse,
      beginClosingRound,
      configuredAgentIds,
      configuredProviders,
      normalizedSession.attachments,
      resetRuntimeState,
      shouldRunObserverPass,
      runObserverPass,
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

  const stopActiveGeneration = useCallback(() => {
    abortRef.current = true;
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
    setMessages((prev) => prev.filter((message) => !message.isStreaming));
  }, []);

  const handlePause = () => {
    stopActiveGeneration();
    pausedRef.current = true;
    setIsPaused(true);
    setSessionStatus("paused");
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

  const handleGracefulEnd = useCallback(async () => {
    if (
      phaseRef.current === "completed" ||
      currentTurnRef.current === 0 ||
      isGracefullyEnding ||
      !isPaused
    ) {
      return;
    }

    stopActiveGeneration();
    setIsGracefullyEnding(true);
    beginClosingRound(
      "Graceful end requested. Closing round: each agent gives a short summary and goodbye, then the Moderator publishes the final summary, score, and explanation.",
    );
    scrollToBottom();

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      hasStartedRef.current = true;
      await runDiscussion("resume");
    } finally {
      setIsGracefullyEnding(false);
    }
  }, [
    beginClosingRound,
    isGracefullyEnding,
    isPaused,
    runDiscussion,
    scrollToBottom,
    stopActiveGeneration,
  ]);

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
      JSON.stringify(endVoteRef.current),
      JSON.stringify(pendingHandoffRef.current),
      messageFingerprint,
      persistedMessages.length,
    ].join("::");

    if (lastPersistSignatureRef.current === signature) {
      return;
    }
    lastPersistSignatureRef.current = signature;

    try {
      const persisted = onPersistSession({
        id: normalizedSession.id,
        topic,
        title: normalizedSession.title,
        createdAt: normalizedSession.createdAt,
        updatedAt: nextUpdatedAt,
        lastOpenedAt: Math.max(normalizedSession.lastOpenedAt, normalizedSession.updatedAt),
        archivedAt: normalizedSession.archivedAt,
        projectId: normalizedSession.projectId,
        status: nextStatus,
        currentTurn: currentTurnRef.current,
        totalTokens,
        moderatorUsage,
        observerUsage,
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
          endVote: endVoteRef.current,
          pendingHandoff: pendingHandoffRef.current,
        },
        canvasStates: canvasStatesRef.current,
      });

      setPersistenceError(null);
      setLastSavedAt(persisted.updatedAt);
    } catch (error) {
      lastPersistSignatureRef.current = "";
      setPersistenceError(
        error instanceof Error ? error.message : "Failed to save the session locally.",
      );
    }
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

  const totalEstimatedCostUSD = (costState?.totalEstimatedUSD ?? 0) + moderatorUsage.estimatedUSD + observerUsage.estimatedUSD;
  const hasAnyPricing =
    (costState
      ? Object.values(costState.agentCosts).some((agent) => agent.pricingAvailable)
      : false) || moderatorUsage.pricingAvailable || observerUsage.pricingAvailable;

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
                  {persistenceError
                    ? persistenceError
                    : `Autosaved locally at ${formattedLastSavedAt}`}
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
              <div className="text-sm text-ink-500" style={{ fontFamily: "var(--font-mono)" }}>
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

            {/* Gracefully End button moved after Pause — see below */}

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

            {normalizedSession.projectId && normalizedSession.attachments.length > 0 && (
              <button
                onClick={() => {
                  const projectId = normalizedSession.projectId;
                  if (!projectId) return;
                  const project = loadProject(projectId);
                  if (!project) return;
                  const existingIds = new Set(project.dossier.map((d) => d.attachmentId));
                  const newEntries = normalizedSession.attachments.filter(
                    (a) => !existingIds.has(a.id),
                  );
                  if (newEntries.length === 0) return;
                  for (const attachment of newEntries) {
                    addDossierEntry(projectId, {
                      attachmentId: attachment.id,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      size: attachment.size,
                      kind: attachment.kind,
                      sourceSessionId: normalizedSession.id,
                      note: attachment.fallbackText.slice(0, 200),
                    });
                  }
                }}
                className="button-secondary text-sm"
                title="Promote session attachments to the project dossier"
              >
                Save to Dossier
              </button>
            )}

            {sessionStatus !== "completed" &&
              (isRunning || isPaused || sessionStatus === "paused" || currentTurn > 0) && (
                <>
                  <button
                    onClick={handlePauseResume}
                    disabled={isGracefullyEnding}
                    className={`session-control-icon-button ${isPaused ? "is-resume" : "is-pause"}`}
                    title={isPaused ? "Resume" : "Pause"}
                  >
                    {isPaused ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <polygon points="8 6 18 12 8 18 8 6" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
                        <line x1="10" y1="7" x2="10" y2="17" />
                        <line x1="14" y1="7" x2="14" y2="17" />
                      </svg>
                    )}
                  </button>
                  {currentTurn > 0 && (
                    <button
                      onClick={() => setShowGracefulEndConfirm(true)}
                      disabled={isGracefullyEnding}
                      className="session-control-icon-button is-graceful-end"
                      title="Gracefully end discussion"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path d="M5 5v14" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
                        <path d="m9 7 10 5-10 5V7Z" fill="currentColor" />
                      </svg>
                    </button>
                  )}
                </>
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
            data={displayMessages}
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
              // Observer note — compact inline card
              const obsNote = (message as ChatMessage & { observerNote?: ObserverNoteSnapshot }).observerNote;
              if (obsNote) {
                const partnerColor = AGENT_CONFIG[obsNote.partnerId as CouncilAgentId]?.color ?? "text-ink-500";
                const partnerAccent = `var(--color-${obsNote.partnerId})`;
                return (
                  <div
                    className="observer-note-card"
                    style={{ borderLeftColor: partnerAccent }}
                  >
                    <div className="observer-note-header">
                      <span className="observer-note-label">private note</span>
                      <span className="observer-note-names">
                        <span style={{ opacity: 0.6 }}>{obsNote.observerName}</span>
                        {" → "}
                        <span className={partnerColor}>{obsNote.partnerName}</span>
                      </span>
                      <span className="observer-note-time">
                        {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <div className="observer-note-body">{message.content}</div>
                  </div>
                );
              }

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
              const messageAttachments = getMessageAttachments(message);
              const hasStructuredMessageBody = Boolean(
                message.endVoteBoard || message.endVoteBallot || message.moderatorConclusion,
              );

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
                      {/* Thinking / Working collapsible — above content */}
                      {(isAgent || isModerator) &&
                        (!!message.thinking?.trim() || (message.toolEvents?.length ?? 0) > 0) && (
                          <details
                            className={`thinking-panel${message.isStreaming ? " is-streaming" : ""}`}
                          >
                            <summary className="thinking-summary">
                              {message.isStreaming
                                ? (message.toolEvents?.length ?? 0) > 0
                                  ? "Working\u2026"
                                  : "Thinking\u2026"
                                : (message.toolEvents?.length ?? 0) > 0
                                  ? `Worked for ${((message.thinkingMs ?? message.latencyMs ?? 0) / 1000).toFixed(3)}s`
                                  : `Thought for ${((message.thinkingMs ?? message.latencyMs ?? 0) / 1000).toFixed(3)}s`}
                            </summary>
                            <div className="thinking-content-wrapper">
                              {(message.toolEvents?.length ?? 0) > 0 && (
                                <div className="thinking-tool-list">
                                  {message.toolEvents!.map((event) => (
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
                              )}
                              {!!message.thinking?.trim() && (
                                <div className="thinking-content">{message.thinking}</div>
                              )}
                            </div>
                          </details>
                        )}
                      {isAgent && (canvasStates[message.agentId as CouncilAgentId]?.sections?.length ?? 0) > 0 && (
                        <AgentCanvas
                          canvas={canvasStates[message.agentId as CouncilAgentId]!}
                          agentColor={AGENT_CONFIG[message.agentId as CouncilAgentId]?.color ?? "var(--ink-500)"}
                          isStreaming={!!message.isStreaming}
                          isExpanded={expandedCanvases[message.agentId] ?? !!message.isStreaming}
                          onToggleExpand={() =>
                            setExpandedCanvases((prev) => ({
                              ...prev,
                              [message.agentId]: !(prev[message.agentId] ?? false),
                            }))
                          }
                        />
                      )}
                      {message.endVoteBoard ? (
                        <EndVoteBoardCard board={message.endVoteBoard} />
                      ) : message.endVoteBallot ? (
                        <EndVoteBallotCard ballot={message.endVoteBallot} />
                      ) : message.moderatorConclusion ? (
                        <>
                          <ModeratorConclusionCard conclusion={message.moderatorConclusion} />
                          {message.deepResearchReport && (
                            <DeepResearchReportCard
                              report={message.deepResearchReport}
                              onJumpToMessage={jumpToMessage}
                            />
                          )}
                        </>
                      ) : message.isStreaming ? (
                        <div className="markdown-content" style={{ whiteSpace: "pre-wrap" }}>
                          {message.content}
                        </div>
                      ) : isModerator ? (
                        <Markdown
                          content={message.content}
                          className="markdown-content"
                        />
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
                                    {qReactions.map(([reactionId, reaction]) => {
                                      const reactorColor =
                                        reaction.by.length === 1 && isCouncilAgent(reaction.by[0])
                                          ? `var(--color-${reaction.by[0]})`
                                          : undefined;
                                      return (
                                        <div
                                          key={reactionId}
                                          className="reaction-chip"
                                          style={
                                            reactorColor
                                              ? {
                                                  borderColor: reactorColor,
                                                  background: `color-mix(in srgb, ${reactorColor} 12%, transparent)`,
                                                }
                                              : undefined
                                          }
                                        >
                                          <ReactionIcon type={reactionId} size={14} />
                                          <span>{reaction.count}</span>
                                        </div>
                                      );
                                    })}
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
                      {messageAttachments.length > 0 && (
                        <div className="message-attachment-list">
                          {messageAttachments.map((attachment) => {
                            const payload = attachmentPayloads.get(attachment.id);
                            const previewSrc =
                              attachment.kind === "image" && payload
                                ? `data:${attachment.mimeType};base64,${payload.data}`
                                : null;

                            return (
                              <div key={attachment.id} className="message-attachment-chip">
                                {previewSrc ? (
                                  <img
                                    src={previewSrc}
                                    alt={attachment.name}
                                    className="message-attachment-thumb"
                                  />
                                ) : (
                                  <div className="message-attachment-fallback-icon">
                                    <MessageAttachmentIcon size={16} />
                                  </div>
                                )}
                                <div className="message-attachment-copy">
                                  <span>{attachment.name}</span>
                                  <span>{getAttachmentKindLabel(attachment)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {message.isStreaming && (
                        <span className="typing-indicator">
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                        </span>
                      )}
                    </div>

                    {!hasStructuredMessageBody && (
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
                    )}

                    {!hasStructuredMessageBody && reactionPickerTarget === message.id && (
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
                        {reactionEntries.map(([reactionId, reaction]) => {
                          const reactorColor =
                            reaction.by.length === 1 && isCouncilAgent(reaction.by[0])
                              ? `var(--color-${reaction.by[0]})`
                              : undefined;
                          return (
                            <div
                              key={reactionId}
                              className="reaction-chip"
                              style={
                                reactorColor
                                  ? {
                                      borderColor: reactorColor,
                                      background: `color-mix(in srgb, ${reactorColor} 12%, transparent)`,
                                    }
                                  : undefined
                              }
                            >
                              <ReactionIcon type={reactionId} size={16} />
                              <span>{reaction.count}</span>
                            </div>
                          );
                        })}
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
                <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]" style={{ fontFamily: "var(--font-mono)" }}>
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
              <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-4" style={{ fontFamily: "var(--font-mono)" }}>
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
                          {agent.name}<span className="opacity-40"> & {AGENT_PARTNERS[agentId]}</span>
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
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3" style={{ fontFamily: "var(--font-mono)" }}>
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
                  <h3 className="text-[10px] font-semibold text-ink-500 uppercase tracking-[0.24em]" style={{ fontFamily: "var(--font-mono)" }}>
                    Cost Ledger
                  </h3>
                  <span className="badge text-[10px]">
                    {totalTokens.input + totalTokens.output} tokens
                  </span>
                </div>
                {costState ? (
                  <div className="space-y-2 text-[10px]" style={{ fontFamily: "var(--font-mono)" }}>
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
                    {(observerUsage.inputTokens > 0 || observerUsage.outputTokens > 0) && (
                      <div className="flex items-center justify-between">
                        <span className="text-ink-400">Observers</span>
                        <span className="text-ink-500">
                          {observerUsage.inputTokens}/{observerUsage.outputTokens} · r:
                          {observerUsage.reasoningTokens} ·{" "}
                          {observerUsage.pricingAvailable
                            ? `$${observerUsage.estimatedUSD.toFixed(4)}`
                            : "—"}
                        </span>
                      </div>
                    )}
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
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em] mb-3" style={{ fontFamily: "var(--font-mono)" }}>
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
          <div className="flex items-center justify-center gap-3 text-sm" style={{ fontFamily: "var(--font-mono)" }}>
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

      {/* Graceful End confirmation modal */}
      {showGracefulEndConfirm && (
        <div className="modal-overlay" onClick={() => setShowGracefulEndConfirm(false)}>
          <div
            className="modal-content graceful-end-confirm-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="graceful-end-confirm-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 5v14" />
                <path d="m9 7 10 5-10 5V7Z" fill="#fb923c" stroke="none" />
              </svg>
            </div>
            <h3 className="graceful-end-confirm-title">End discussion?</h3>
            <p className="graceful-end-confirm-copy">
              This will move to closing summaries. Each agent will give a final reflection, then the moderator will score the discussion. This action cannot be undone.
            </p>
            <div className="graceful-end-confirm-actions">
              <button
                className="graceful-end-confirm-btn is-cancel"
                onClick={() => setShowGracefulEndConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="graceful-end-confirm-btn is-confirm"
                onClick={() => {
                  setShowGracefulEndConfirm(false);
                  void handleGracefulEnd();
                }}
              >
                End discussion
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
