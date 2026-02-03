import { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import type { Page } from "../App";
import { useConfig, PROVIDER_INFO, type Provider } from "../stores/config";
import { callProvider, apiLogger, type ChatMessage as APIChatMessage } from "../services/api";
import { ProviderIcon, SystemIcon, UserIcon } from "../components/icons/ProviderIcons";
import { ReactionIcon, type ReactionId } from "../components/icons/ReactionIcons";
import { ConflictDetector, CostTrackerEngine } from "@socratic-council/core";
import type {
  ConflictDetection,
  CostTracker,
  WhisperMessage,
  Message as SharedMessage,
  AgentId as CouncilAgentId,
  ModelId,
} from "@socratic-council/shared";
import { callMcpTool, formatMcpResult } from "../services/mcp";

interface ChatProps {
  topic: string;
  onNavigate: (page: Page) => void;
}

interface ChatMessage extends SharedMessage {
  isStreaming?: boolean;
  latencyMs?: number;
  error?: string;
  quotedMessageId?: string;
  plan?: string;
  reactions?: Partial<Record<ReactionId, { count: number; by: string[] }>>;
}

interface BiddingRound {
  scores: Record<CouncilAgentId, number>;
  winner: CouncilAgentId;
}

type AgentId = CouncilAgentId | "system" | "user";

interface DuoLogueState {
  participants: [CouncilAgentId, CouncilAgentId];
  remainingTurns: number;
}

// Model display names mapping
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // OpenAI
  "gpt-5.2-pro": "GPT-5.2 Pro",
  "gpt-5.2": "GPT-5.2",
  "gpt-5-mini": "GPT-5 Mini",
  "o3": "o3",
  "o4-mini": "o4-mini",
  "gpt-4o": "GPT-4o",
  // Anthropic
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  // Google
  "gemini-3-pro-preview": "Gemini 3 Pro",
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
};

const INTERACTION_COMMANDS = `
Tool commands (put each command on its own line at the end):
- Quote a message: @quote(MSG_ID)
- React to a message: @react(MSG_ID, thumbs_up|heart|laugh|sparkle)
- Plan for a pivotal response: @plan(step1; step2; step3)
- Call an MCP tool: @mcp(tool_name, {"key":"value"})

Rules:
- Use at least one @quote and one @react in every substantive response.
- If you are preparing a major/pivotal response, include @plan(...) before your main answer.
- If you have nothing new, give a 1-sentence acknowledgement and still add @react or @plan.
- Do not use meta disclaimers like "this is a massive topic"—start with substance.
- Be interactive: build on or oppose specific points and connect ideas across speakers.

You can see message IDs in the context (format: msg_xxx). Do not invent IDs.`;

const AGENT_CONFIG: Record<AgentId, {
  name: string;
  role: string;
  color: string;
  bgColor: string;
  borderColor: string;
  provider: Provider;
  systemPrompt: string;
}> = {
  george: {
    name: "George",
    role: "Logician",
    color: "text-george",
    bgColor: "bg-george/10",
    borderColor: "border-george",
    provider: "openai",
    systemPrompt: `You are George, participating in a group discussion with Cathy, Grace, Douglas, and Kate.

Your approach: You think carefully about the logical structure of arguments. When you spot flawed reasoning, you point it out clearly but without being condescending.

Guidelines:
- Speak naturally, like you're having a conversation with friends
- Only respond to what others have actually said - never make up or assume their arguments
- If someone hasn't spoken yet, don't reference them
- If you're the first to speak, just share your initial thoughts on the topic
- Keep responses conversational (2-3 paragraphs)
- Address people by name when responding to their specific points
${INTERACTION_COMMANDS}`
  },
  cathy: {
    name: "Cathy",
    role: "Ethicist",
    color: "text-cathy",
    bgColor: "bg-cathy/10",
    borderColor: "border-cathy",
    provider: "anthropic",
    systemPrompt: `You are Cathy, participating in a group discussion with George, Grace, Douglas, and Kate.

Your approach: You care about the human impact of issues. You think about who benefits, who might be harmed, and what values are at stake.

Guidelines:
- Speak naturally, like you're having a conversation with friends
- Only respond to what others have actually said - never make up or assume their arguments
- If someone hasn't spoken yet, don't reference them
- If you're the first to speak, just share your initial thoughts on the topic
- Keep responses conversational (2-3 paragraphs)
- Address people by name when responding to their specific points
${INTERACTION_COMMANDS}`
  },
  grace: {
    name: "Grace",
    role: "Futurist",
    color: "text-grace",
    bgColor: "bg-grace/10",
    borderColor: "border-grace",
    provider: "google",
    systemPrompt: `You are Grace, participating in a group discussion with George, Cathy, Douglas, and Kate.

Your approach: You like to think about where things are heading. You consider long-term consequences and how today's decisions might play out over time.

Guidelines:
- Speak naturally, like you're having a conversation with friends
- Only respond to what others have actually said - never make up or assume their arguments
- If someone hasn't spoken yet, don't reference them
- If you're the first to speak, just share your initial thoughts on the topic
- Keep responses conversational (2-3 paragraphs)
- Address people by name when responding to their specific points
${INTERACTION_COMMANDS}`
  },
  douglas: {
    name: "Douglas",
    role: "Skeptic",
    color: "text-douglas",
    bgColor: "bg-douglas/10",
    borderColor: "border-douglas",
    provider: "deepseek",
    systemPrompt: `You are Douglas, participating in a group discussion with George, Cathy, Grace, and Kate.

Your approach: You like to question assumptions and ask for evidence. You're not trying to be difficult - you just think it's important to examine claims carefully.

Guidelines:
- Speak naturally, like you're having a conversation with friends
- Only respond to what others have actually said - never make up or assume their arguments
- If someone hasn't spoken yet, don't reference them
- If you're the first to speak, just share your initial thoughts on the topic
- Keep responses conversational (2-3 paragraphs)
- Address people by name when responding to their specific points
${INTERACTION_COMMANDS}`
  },
  kate: {
    name: "Kate",
    role: "Historian",
    color: "text-kate",
    bgColor: "bg-kate/10",
    borderColor: "border-kate",
    provider: "kimi",
    systemPrompt: `You are Kate, participating in a group discussion with George, Cathy, Grace, and Douglas.

Your approach: You like to bring historical perspective to discussions. You find it helpful to look at how similar situations played out in the past.

Guidelines:
- Speak naturally, like you're having a conversation with friends
- Only respond to what others have actually said - never make up or assume their arguments
- If someone hasn't spoken yet, don't reference them
- If you're the first to speak, just share your initial thoughts on the topic
- Keep responses conversational (2-3 paragraphs)
- Address people by name when responding to their specific points
${INTERACTION_COMMANDS}`
  },
  system: {
    name: "System",
    role: "",
    color: "text-ink-500",
    bgColor: "bg-white/60",
    borderColor: "border-line-soft",
    provider: "openai",
    systemPrompt: ""
  },
  user: {
    name: "You",
    role: "",
    color: "text-ink-900",
    bgColor: "bg-white/80",
    borderColor: "border-line-soft",
    provider: "openai",
    systemPrompt: ""
  },
};

const AGENT_IDS: CouncilAgentId[] = ["george", "cathy", "grace", "douglas", "kate"];

const isCouncilAgent = (id: ChatMessage["agentId"]): id is CouncilAgentId =>
  AGENT_IDS.includes(id as CouncilAgentId);

const REACTION_IDS: ReactionId[] = ["thumbs_up", "heart", "laugh", "sparkle"];

const ACTION_PATTERNS = {
  quote: /@quote\(([^)]+)\)/g,
  react: /@react\(([^,]+),\s*([^)]+)\)/g,
  plan: /@plan\(([^)]+)\)/g,
  mcp: /@mcp\(([^,]+),\s*([\s\S]+?)\)/g,
};

function extractActions(raw: string) {
  const reactions: Array<{ targetId: string; emoji: ReactionId }> = [];
  const mcpCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let quoteTarget: string | undefined;
  let plan: string | undefined;

  let cleaned = raw;

  cleaned = cleaned.replace(ACTION_PATTERNS.quote, (_, target) => {
    if (!quoteTarget) quoteTarget = String(target).trim();
    return "";
  });

  cleaned = cleaned.replace(ACTION_PATTERNS.react, (_, target, emoji) => {
    const reaction = String(emoji).trim() as ReactionId;
    if (REACTION_IDS.includes(reaction)) {
      reactions.push({ targetId: String(target).trim(), emoji: reaction });
    }
    return "";
  });

  cleaned = cleaned.replace(ACTION_PATTERNS.plan, (_, planText) => {
    if (!plan) plan = String(planText).trim();
    return "";
  });

  cleaned = cleaned.replace(ACTION_PATTERNS.mcp, (_, tool, args) => {
    try {
      const parsed = JSON.parse(String(args));
      mcpCalls.push({ tool: String(tool).trim(), args: parsed });
    } catch {
      // Ignore malformed MCP blocks
    }
    return "";
  });

  return {
    cleaned: cleaned.trim(),
    quoteTarget,
    reactions,
    plan,
    mcpCalls,
  };
}

function applyReactions(
  items: ChatMessage[],
  reactions: Array<{ targetId: string; emoji: ReactionId }>,
  actorId: CouncilAgentId
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

export function Chat({ topic, onNavigate }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [typingAgents, setTypingAgents] = useState<CouncilAgentId[]>([]);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [showBidding, setShowBidding] = useState(false);
  const [currentBidding, setCurrentBidding] = useState<BiddingRound | null>(null);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const [isPaused, setIsPaused] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [costState, setCostState] = useState<CostTracker | null>(null);
  const [conflictState, setConflictState] = useState<ConflictDetection | null>(null);
  const [duoLogue, setDuoLogue] = useState<DuoLogueState | null>(null);
  const [whisperLog, setWhisperLog] = useState<WhisperMessage[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const activeRequestsRef = useRef<Map<CouncilAgentId, AbortController>>(new Map());
  const costTrackerRef = useRef<CostTrackerEngine | null>(null);
  const conflictDetectorRef = useRef(new ConflictDetector());
  const whisperBonusesRef = useRef<Record<CouncilAgentId, number>>({
    george: 0,
    cathy: 0,
    grace: 0,
    douglas: 0,
    kate: 0,
  });
  const lastWhisperKeyRef = useRef<string | null>(null);
  const duoLogueRef = useRef<DuoLogueState | null>(null);

  const { config, getMaxTurns, getConfiguredProviders } = useConfig();
  const maxTurns = getMaxTurns();
  const configuredProviders = getConfiguredProviders();

  useEffect(() => {
    duoLogueRef.current = duoLogue;
  }, [duoLogue]);

  const resetRuntimeState = useCallback(() => {
    costTrackerRef.current = new CostTrackerEngine(AGENT_IDS);
    setCostState(costTrackerRef.current.getState());
    setTotalTokens({ input: 0, output: 0 });
    setCurrentBidding(null);
    setShowBidding(false);
    setErrors([]);
    setConflictState(null);
    setDuoLogue(null);
    setTypingAgents([]);
    duoLogueRef.current = null;
    setWhisperLog([]);
    lastWhisperKeyRef.current = null;
    whisperBonusesRef.current = {
      george: 0,
      cathy: 0,
      grace: 0,
      douglas: 0,
      kate: 0,
    };
  }, []);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (config.preferences.autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, config.preferences.autoScroll]);

  useEffect(() => {
    const agentMessages = messages.filter(
      (m) => isCouncilAgent(m.agentId) && !m.isStreaming
    );

    if (agentMessages.length < 2) {
      setConflictState(null);
      return;
    }

    const conflict = conflictDetectorRef.current.evaluate(agentMessages, AGENT_IDS);
    setConflictState(conflict);

    if (conflict && !duoLogueRef.current) {
      const newDuo: DuoLogueState = {
        participants: conflict.agentPair,
        remainingTurns: 3,
      };
      setDuoLogue(newDuo);
      duoLogueRef.current = newDuo;
    }
  }, [messages]);

  useEffect(() => {
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

    setWhisperLog((prev) => [...prev.slice(-9), whisper]);
    whisperBonusesRef.current[to] = Math.min(
      20,
      (whisperBonusesRef.current[to] ?? 0) + (whisper.payload.bidBonus ?? 0)
    );
  }, [conflictState]);

  // Generate bidding scores based on conversation context
  const generateBiddingScores = useCallback((
    excludeAgent?: CouncilAgentId,
    eligibleAgents: CouncilAgentId[] = AGENT_IDS
  ): BiddingRound => {
    const scores = {} as Record<CouncilAgentId, number>;
    let maxScore = -Infinity;
    let winner: CouncilAgentId = eligibleAgents[0] ?? AGENT_IDS[0];
    let hasWinner = false;

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
      const recencyBonus = agentId === excludeAgent ? -20 : 0;
      const whisperBonus = whisperBonusesRef.current[agentId] ?? 0;
      const score = baseScore + recencyBonus + whisperBonus;

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
        (id) => id !== excludeAgent && configuredProviders.includes(AGENT_CONFIG[id].provider)
      );
      winner = available[0] || eligibleAgents[0] || AGENT_IDS[0];
    }

    return { scores, winner };
  }, [configuredProviders]);

  // Build conversation history for API call
  const buildConversationHistory = useCallback((agentId: CouncilAgentId): APIChatMessage[] => {
    const agentConfig = AGENT_CONFIG[agentId];
    const history: APIChatMessage[] = [
      {
        role: "system",
        content: agentConfig.systemPrompt,
      },
    ];

    // Filter to only include messages with actual content (not "[No response received]" or empty)
    const validMessages = messages.filter(
      (m) =>
        m.agentId !== "system" &&
        m.content &&
        m.content.trim() !== "" &&
        !m.content.includes("[No response received]") &&
        !m.content.includes("No responses recorded") &&
        !m.error &&
        !m.isStreaming
    );

    history.push({
      role: "user",
      content: `Discussion topic: "${topic}"`,
    });

    if (validMessages.length === 0) {
      history.push({
        role: "user",
        content:
          "You're the first to speak. Share your initial thoughts on the topic, raise key questions, and set a direction for the discussion.",
      });

      return history;
    }

    for (const msg of validMessages) {
      const speaker = AGENT_CONFIG[msg.agentId] ?? AGENT_CONFIG.system;
      history.push({
        role: "user",
        content: `${speaker.name} (id: ${msg.id}): ${msg.content}`,
      });
    }

    history.push({
      role: "user",
      content:
        "Now it's your turn. Respond to specific points above. Only reference arguments that were actually made.",
    });

    return history;
  }, [messages, topic]);

  // Get model display name
  const getModelDisplayName = useCallback((provider: Provider, overrideModel?: string): string => {
    const modelId = overrideModel || config.models[provider];
    if (!modelId) return "Unknown Model";
    return MODEL_DISPLAY_NAMES[modelId] || modelId;
  }, [config.models]);

  const getProxyForProvider = useCallback((provider: Provider) => {
    const override = config.proxyOverrides?.[provider];
    if (override && override.type !== "none") {
      return { proxy: override, source: "override" as const };
    }
    if (config.proxy.type !== "none") {
      return { proxy: config.proxy, source: "default" as const };
    }
    return { proxy: undefined, source: "none" as const };
  }, [config.proxy, config.proxyOverrides]);

  // Generate agent response using real API
  const generateAgentResponse = useCallback(async (agentId: CouncilAgentId): Promise<ChatMessage | null> => {
    // Check if aborted before starting
    if (abortRef.current) return null;

    const agentConfig = AGENT_CONFIG[agentId];
    const credential = config.credentials[agentConfig.provider];
    const model = config.models[agentConfig.provider];

    if (!credential?.apiKey) {
      const errorMsg = `No API key configured for ${PROVIDER_INFO[agentConfig.provider].name}`;
      apiLogger.log("error", agentConfig.provider, errorMsg);
      setErrors(prev => [...prev, errorMsg]);
      return null;
    }

    if (!model) {
      const errorMsg = `No model configured for ${agentConfig.provider}`;
      apiLogger.log("error", agentConfig.provider, errorMsg);
      setErrors(prev => [...prev, errorMsg]);
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
    };

    setMessages(prev => [...prev, newMessage]);

    // Build conversation history
    const conversationHistory = buildConversationHistory(agentId);

    // Create abort controller for this request
    const controller = new AbortController();
    activeRequestsRef.current.set(agentId, controller);

    const idleTimeoutMs = 120000;
    const requestTimeoutMs = agentConfig.provider === "google" ? 240000 : 180000;
    const { proxy: providerProxy, source: proxySource } = getProxyForProvider(agentConfig.provider);

    apiLogger.log("info", agentConfig.provider, "Dispatching request", {
      model,
      proxy: providerProxy?.type ?? "none",
      proxySource,
      requestTimeoutMs,
      idleTimeoutMs,
    });

    try {
    let modelUsed = model;

    // Call the API
      let result = await callProvider(
        agentConfig.provider,
        credential,
        modelUsed,
        conversationHistory,
        () => {
          // Check if aborted during streaming
          if (abortRef.current) return;
        },
        providerProxy,
        {
          idleTimeoutMs,
          requestTimeoutMs,
          signal: controller.signal,
        }
      );

    if (
      !result.success &&
      agentConfig.provider === "anthropic" &&
      model.includes("4-5")
    ) {
      const fallbackModel = "claude-opus-4-5";
      if (modelUsed !== fallbackModel) {
        apiLogger.log("warn", "anthropic", "Primary model failed; retrying with fallback", {
          primary: model,
          fallback: fallbackModel,
        });
        modelUsed = fallbackModel;
        result = await callProvider(
          agentConfig.provider,
          credential,
          modelUsed,
          conversationHistory,
          () => {
            if (abortRef.current) return;
          },
          providerProxy,
          {
            idleTimeoutMs,
            requestTimeoutMs,
            signal: controller.signal,
          }
        );
      }
    }

      // Check if aborted after request
      if (abortRef.current) {
        // Remove the incomplete message
        setMessages(prev => prev.filter(m => m.id !== newMessage.id));
        return null;
      }

      const { cleaned, quoteTarget, reactions, mcpCalls, plan } = extractActions(result.content || "");
      const displayContent =
        cleaned || (result.content ? "No responses recorded" : "[No response received]");

      // Update message with final data
      const finalMessage: ChatMessage = {
        ...newMessage,
        content: displayContent,
        isStreaming: false,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        error: result.error,
        quotedMessageId: quoteTarget,
        plan,
        metadata: {
          model: modelUsed as ModelId,
          latencyMs: result.latencyMs,
        },
      };

      setMessages(prev => {
        const updated = prev.map(m => m.id === newMessage.id ? finalMessage : m);
        return applyReactions(updated, reactions, agentId);
      });

      if (result.success) {
        setTotalTokens(prev => ({
          input: prev.input + result.tokens.input,
          output: prev.output + result.tokens.output,
        }));

        if (costTrackerRef.current) {
          costTrackerRef.current.recordUsage(agentId, result.tokens, model);
          setCostState(costTrackerRef.current.getState());
        }
      } else {
        setErrors(prev => [...prev, result.error || "Unknown error"]);
      }

      if (mcpCalls.length > 0) {
        for (const call of mcpCalls) {
          if (!config.mcp.enabled || !config.mcp.serverUrl) {
            apiLogger.log("warn", "mcp", "MCP call ignored (not configured)", call);
            continue;
          }

          try {
            const result = await callMcpTool(
              config.mcp.serverUrl,
              call.tool,
              call.args,
              config.mcp.apiKey,
              config.proxy.type !== "none" ? config.proxy : undefined
            );

            const mcpMessage: ChatMessage = {
              id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              agentId: "system",
              content: formatMcpResult(call.tool, result),
              timestamp: Date.now(),
            };

            setMessages(prev => [...prev, mcpMessage]);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown MCP error";
            apiLogger.log("error", "mcp", message, error);
            setErrors(prev => [...prev, message]);
          }
        }
      }

      return finalMessage;
    } finally {
      activeRequestsRef.current.delete(agentId);
      setTypingAgents((prev) => prev.filter((id) => id !== agentId));
    }
  }, [config, buildConversationHistory, getProxyForProvider]);

  // Main discussion loop
  const runDiscussion = useCallback(async () => {
    setIsRunning(true);
    abortRef.current = false;
    resetRuntimeState();

    // Add topic as system message
    const topicMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      agentId: "system",
      content: `Discussion Topic: "${topic}"`,
      timestamp: Date.now(),
    };
    setMessages([topicMessage]);

    let previousSpeaker: CouncilAgentId | null = null;
    let turn = 0;

    while (!abortRef.current && (maxTurns === Infinity || turn < maxTurns)) {
      // Check for pause
      while (isPaused && !abortRef.current) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (abortRef.current) break;

      setCurrentTurn(turn + 1);

      // Run bidding round
      const eligibleAgents = duoLogueRef.current?.remainingTurns
        ? duoLogueRef.current.participants
        : AGENT_IDS;

      const bidding = generateBiddingScores(previousSpeaker ?? undefined, eligibleAgents);

      if (config.preferences.showBiddingScores) {
        setCurrentBidding(bidding);
        setShowBidding(true);
        await new Promise(resolve => setTimeout(resolve, 1500));
        setShowBidding(false);
      }

      if (abortRef.current) break;

      // Generate responses from top agents (group chat style)
      const rankedAgents = (Object.entries(bidding.scores) as [CouncilAgentId, number][])
        .filter(([agentId, score]) => score > 0 && configuredProviders.includes(AGENT_CONFIG[agentId].provider))
        .sort((a, b) => b[1] - a[1])
        .map(([agentId]) => agentId);

      const maxConcurrentSpeakers = duoLogueRef.current?.remainingTurns ? 1 : 2;
      const winners = rankedAgents.slice(0, Math.max(1, maxConcurrentSpeakers));

      if (winners.length === 0) {
        break;
      }

      const responses = await Promise.all(winners.map((winner) => generateAgentResponse(winner)));

      if (abortRef.current) break;

      if (responses.every((response) => !response || response.error)) {
        // If failed, try another agent
        const alternates = eligibleAgents.filter(
          (id) => !winners.includes(id) && configuredProviders.includes(AGENT_CONFIG[id].provider)
        );

        if (alternates.length > 0 && !abortRef.current) {
          const alternate = alternates[Math.floor(Math.random() * alternates.length)];
          await generateAgentResponse(alternate);
        }
      }

      if (abortRef.current) break;

      previousSpeaker = winners[0] ?? previousSpeaker;
      turn++;

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

      // Small delay between turns
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    setIsRunning(false);
  }, [
    topic,
    maxTurns,
    isPaused,
    config.preferences.showBiddingScores,
    generateBiddingScores,
    generateAgentResponse,
    configuredProviders,
    resetRuntimeState,
  ]);

  // Start discussion when component mounts
  useEffect(() => {
    if (configuredProviders.length > 0) {
      runDiscussion();
    } else {
      setMessages([{
        id: `msg_${Date.now()}`,
        agentId: "system",
        content: `No API keys configured. Please go to Settings and configure at least one provider to start the discussion.`,
        timestamp: Date.now(),
        error: "No API keys configured",
      }]);
    }

    return () => {
      abortRef.current = true;
      for (const controller of activeRequestsRef.current.values()) {
        controller.abort();
      }
      activeRequestsRef.current.clear();
    };
  }, []);

  const handleStop = () => {
    abortRef.current = true;
    for (const controller of activeRequestsRef.current.values()) {
      controller.abort();
    }
    activeRequestsRef.current.clear();
    setIsRunning(false);
    setTypingAgents([]);
    setIsPaused(false);
  };

  const handlePauseResume = () => {
    setIsPaused(!isPaused);
  };

  const displayMaxTurns = maxTurns === Infinity ? "\u221E" : maxTurns;

  // Format timestamp for Discord-style display
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="app-shell flex flex-col h-screen">
      <div className="ambient-canvas" aria-hidden="true" />
      {/* Header */}
      <div className="app-header px-6 py-4 relative z-10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                handleStop();
                onNavigate("home");
              }}
              className="button-ghost"
            >
              &larr; Back
            </button>
            <div className="divider-vertical"></div>
            <div>
              <h1 className="text-lg font-semibold text-ink-900 flex items-center gap-2">
                Socratic Council
              </h1>
              <p className="text-sm text-ink-500 truncate max-w-lg">
                {topic}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 justify-start lg:justify-end">
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

            <div className="badge badge-info">
              {totalTokens.input + totalTokens.output} tokens
            </div>

            {costState && (
              <div className="badge">
                {Object.values(costState.agentCosts).some((agent) => agent.pricingAvailable)
                  ? `$${costState.totalEstimatedUSD.toFixed(4)}`
                  : "Cost N/A"}
              </div>
            )}

            {duoLogue && (
              <div className="badge badge-warning">
                Duo-Logue · {duoLogue.remainingTurns} turns
              </div>
            )}

            <button
              onClick={() => setShowLogs(!showLogs)}
              className="button-secondary text-sm"
            >
              Logs {errors.length > 0 && `(${errors.length})`}
            </button>

            {isRunning && (
              <>
                <button
                  onClick={handlePauseResume}
                  className="button-secondary text-sm"
                >
                  {isPaused ? "Resume" : "Pause"}
                </button>
                <button
                  onClick={handleStop}
                  className="button-primary text-sm"
                >
                  Stop
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative z-10">
        {/* Messages area - Discord style */}
        <div className="flex-1 overflow-y-auto">
          <div className="discord-messages">
            {messages.map((message) => {
              const agent = AGENT_CONFIG[message.agentId] ?? AGENT_CONFIG.system;
              const isAgent = isCouncilAgent(message.agentId);
              const isSystem = message.agentId === "system";
              const modelName = isAgent
                ? getModelDisplayName(agent.provider, message.metadata?.model)
                : "";
              const accent = isSystem
                ? "var(--accent-ink)"
                : message.agentId === "user"
                  ? "var(--accent-emerald)"
                  : `var(--color-${message.agentId})`;
              const accentStyle = { "--accent": accent } as CSSProperties;
              const quotedMessage = message.quotedMessageId
                ? messages.find((msg) => msg.id === message.quotedMessageId)
                : null;
              const reactionEntries = message.reactions
                ? (Object.entries(message.reactions) as [ReactionId, { count: number; by: string[] }][]).filter(
                    ([, reaction]) => reaction?.count
                  )
                : [];

              return (
                <div
                  key={message.id}
                  className={`discord-message message-enter ${message.error ? "has-error" : ""}`}
                  style={accentStyle}
                >
                  {/* Avatar */}
                  <div className="discord-avatar">
                    {isSystem ? (
                      <SystemIcon size={40} />
                    ) : message.agentId === "user" ? (
                      <UserIcon size={40} />
                    ) : (
                      <ProviderIcon provider={agent.provider} size={40} />
                    )}
                    {isCouncilAgent(message.agentId) && typingAgents.includes(message.agentId) && message.isStreaming && (
                      <div className="avatar-speaking-indicator" />
                    )}
                  </div>

                  {/* Message content */}
                  <div className="discord-message-content">
                    {/* Header: Name (Model) + timestamp */}
                    <div className="discord-message-header">
                      <span className={`discord-username ${agent.color}`}>
                        {agent.name}
                      </span>
                      {isAgent && modelName && (
                        <span className="discord-model">({modelName})</span>
                      )}
                      {isAgent && (
                        <span className="discord-role">{agent.role}</span>
                      )}
                      <span className="discord-timestamp">
                        {formatTime(message.timestamp)}
                      </span>
                      {message.tokens && (
                        <span className="discord-tokens">
                          {message.tokens.input}+{message.tokens.output} tokens
                        </span>
                      )}
                    </div>

                    {quotedMessage && (
                      <div className="message-quote">
                        <div className="message-quote-header">
                          {AGENT_CONFIG[quotedMessage.agentId].name} · {formatTime(quotedMessage.timestamp)}
                        </div>
                        <div className="message-quote-body">
                          {quotedMessage.content.slice(0, 200)}
                          {quotedMessage.content.length > 200 ? "…" : ""}
                        </div>
                      </div>
                    )}

                    {message.plan && (
                      <div className="message-plan">
                        <div className="message-plan-header">Planning</div>
                        <div className="message-plan-body">{message.plan}</div>
                      </div>
                    )}

                    {/* Message body */}
                    <div className="discord-message-body">
                      {message.content}
                      {message.isStreaming && (
                        <span className="typing-indicator">
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                          <span className="typing-dot" />
                        </span>
                      )}
                    </div>

                    <div className="message-actions">
                      <button type="button" className="message-action">
                        Quote
                      </button>
                      <button type="button" className="message-action">
                        React
                      </button>
                    </div>

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
                    {message.error && (
                      <div className="discord-error">
                        {message.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Right sidebar - Agent status & Bidding */}
        <div className="w-full md:w-80 md:border-l border-line-soft side-panel p-4 overflow-y-auto">
          {showLogs ? (
            // Logs panel
            <div className="scale-in">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
                  API Logs
                </h3>
                <button
                  onClick={() => apiLogger.clearLogs()}
                  className="button-ghost text-xs"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-2 text-xs">
                {apiLogger.getLogs().slice(-20).reverse().map((log, i) => (
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
                      {isSpeaking && (
                        <span className="badge badge-success text-xs">Speaking</span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="panel-card p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
                    Conflict Meter
                  </h3>
                  {conflictState && (
                    <span className="badge badge-warning text-xs">
                      {conflictState.conflictScore}%
                    </span>
                  )}
                </div>
                {conflictState ? (
                  <>
                    <div className="text-sm text-ink-700 mb-2">
                      {AGENT_CONFIG[conflictState.agentPair[0]].name} vs{" "}
                      {AGENT_CONFIG[conflictState.agentPair[1]].name}
                    </div>
                    <div className="conflict-track">
                      <div
                        className="conflict-fill"
                        style={{ width: `${Math.min(conflictState.conflictScore, 100)}%` }}
                      />
                    </div>
                    {duoLogue && (
                      <div className="text-xs text-ink-500 mt-2">
                        Duo-Logue active · {duoLogue.remainingTurns} turns remaining
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-ink-500">No active conflicts detected.</div>
                )}
              </div>

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
                                  isWinner ? "bg-gradient-to-r from-emerald-600 to-amber-400" : "bg-slate-400"
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
                      const tokenCount =
                        (breakdown?.inputTokens ?? 0) + (breakdown?.outputTokens ?? 0);

                      return (
                        <div key={agentId} className="flex items-center justify-between">
                          <span className={`text-ink-700 ${agent.color}`}>
                            {agent.name}
                          </span>
                          <span className="text-ink-500">
                            {tokenCount} · {costLabel}
                          </span>
                        </div>
                      );
                    })}
                    <div className="pt-2 border-t border-line-soft flex items-center justify-between">
                      <span className="text-ink-500">Estimated total</span>
                      <span className="text-ink-900">
                        {Object.values(costState.agentCosts).some((agent) => agent.pricingAvailable)
                          ? `$${costState.totalEstimatedUSD.toFixed(4)}`
                          : "Pricing not configured"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-ink-500">No usage recorded yet.</div>
                )}
              </div>

              <div className="panel-card p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
                    Whisper Log
                  </h3>
                  <span className="badge text-xs">{whisperLog.length}</span>
                </div>
                {whisperLog.length === 0 ? (
                  <div className="text-sm text-ink-500">No whispers yet.</div>
                ) : (
                  <div className="space-y-2 text-xs text-ink-700">
                    {whisperLog.slice(-5).map((whisper) => (
                        <div key={whisper.id} className="border-l border-line-soft pl-2">
                          <div className="font-medium">
                            {AGENT_CONFIG[whisper.from].name} → {AGENT_CONFIG[whisper.to].name}
                          </div>
                        <div className="text-ink-500">
                          {whisper.payload.proposedAction ?? "No strategy details provided."}
                        </div>
                        </div>
                    ))}
                  </div>
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
                          handleStop();
                          onNavigate("home");
                        }}
                        className="w-full button-primary text-sm"
                      >
                        New Discussion
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
