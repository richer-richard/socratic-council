/**
 * @fileoverview Council orchestration - manages the debate flow
 * Coordinates agents, bidding, and message streaming
 */

import type {
  AgentConfig,
  AgentId,
  CouncilConfig,
  CouncilState,
  CostTracker,
  ConflictDetection,
  DuoLogue,
  Message,
  OracleResult,
  ProviderCredentials,
  WhisperMessage,
} from "@socratic-council/shared";
import { DEFAULT_AGENTS, DEFAULT_COUNCIL_CONFIG } from "@socratic-council/shared";
import {
  type CompletionResult,
  ProviderManager,
  type StreamCallback,
  formatConversationHistory,
} from "@socratic-council/sdk";
import type { Transport } from "@socratic-council/sdk";
import { runBiddingRound } from "./bidding.js";
import { CostTrackerEngine } from "./cost.js";
import { ConflictDetector } from "./conflict.js";
import { DuckDuckGoOracle } from "./oracle.js";
import { WhisperManager } from "./whisper.js";

const VALID_AGENT_IDS = ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary"] as const;
const VALID_PROVIDERS = ["openai", "anthropic", "google", "deepseek", "kimi", "qwen", "minimax"] as const;
const VALID_STATUSES = ["idle", "running", "paused", "completed"] as const;

function cloneSnapshot<T>(value: T): T {
  return structuredClone(value);
}

function normalizeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const normalized = normalizeNumber(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && VALID_AGENT_IDS.includes(value as AgentId);
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("ABORTED") || error.message.includes("aborted"))
  );
}

function normalizeCouncilConfigValue(input: unknown): CouncilConfig {
  const record = input && typeof input === "object" ? (input as Partial<CouncilConfig>) : {};
  return {
    topic: typeof record.topic === "string" ? record.topic : "",
    maxTurns: normalizePositiveNumber(record.maxTurns, DEFAULT_COUNCIL_CONFIG.maxTurns),
    biddingTimeout: normalizePositiveNumber(
      record.biddingTimeout,
      DEFAULT_COUNCIL_CONFIG.biddingTimeout,
    ),
    budgetLimit: Math.max(0, normalizeNumber(record.budgetLimit, DEFAULT_COUNCIL_CONFIG.budgetLimit)),
    autoMode:
      typeof record.autoMode === "boolean" ? record.autoMode : DEFAULT_COUNCIL_CONFIG.autoMode,
  };
}

function normalizeAgentConfig(input: unknown): AgentConfig | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<AgentConfig>;
  if (!isAgentId(record.id)) return null;

  const base = DEFAULT_AGENTS[record.id];
  const provider =
    typeof record.provider === "string" &&
    VALID_PROVIDERS.includes(record.provider as (typeof VALID_PROVIDERS)[number])
      ? record.provider
      : base.provider;
  const model = typeof record.model === "string" && record.model.length > 0 ? record.model : base.model;
  const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name : base.name;
  const systemPrompt =
    typeof record.systemPrompt === "string" && record.systemPrompt.length > 0
      ? record.systemPrompt
      : base.systemPrompt;

  return {
    ...base,
    provider,
    model,
    name,
    systemPrompt,
    ...(typeof record.avatar === "string" && record.avatar.length > 0 ? { avatar: record.avatar } : {}),
    ...(typeof record.temperature === "number" && Number.isFinite(record.temperature)
      ? { temperature: record.temperature }
      : {}),
    ...(typeof record.maxTokens === "number" && Number.isFinite(record.maxTokens) && record.maxTokens > 0
      ? { maxTokens: record.maxTokens }
      : {}),
  };
}

function normalizeMessageValue(input: unknown): Message | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<Message>;
  const validAgentId =
    record.agentId === "user" ||
    record.agentId === "system" ||
    record.agentId === "tool" ||
    isAgentId(record.agentId);

  if (!validAgentId) return null;
  const agentId = record.agentId as Message["agentId"];

  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : generateId("msg");
  const content = typeof record.content === "string" ? record.content : "";
  const timestamp = normalizeNumber(record.timestamp, Date.now());
  const inputTokens = normalizeNumber(record.tokens?.input);
  const outputTokens = normalizeNumber(record.tokens?.output);
  const reasoningTokens =
    typeof record.tokens?.reasoning === "number" && Number.isFinite(record.tokens.reasoning)
      ? record.tokens.reasoning
      : undefined;
  const metadata =
    record.metadata &&
    typeof record.metadata === "object" &&
    typeof record.metadata.model === "string" &&
    typeof record.metadata.latencyMs === "number"
      ? {
          model: record.metadata.model,
          latencyMs: record.metadata.latencyMs,
          ...(typeof record.metadata.bidScore === "number" && Number.isFinite(record.metadata.bidScore)
            ? { bidScore: record.metadata.bidScore }
            : {}),
        }
      : undefined;

  return {
    id,
    agentId,
    content,
    timestamp,
    ...((inputTokens > 0 || outputTokens > 0 || reasoningTokens !== undefined)
      ? {
          tokens: {
            input: inputTokens,
            output: outputTokens,
            ...(reasoningTokens !== undefined ? { reasoning: reasoningTokens } : {}),
          },
        }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeCostTrackerValue(
  input: unknown,
  agentIds: AgentId[],
): CostTracker | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<CostTracker>;
  const agentCosts = {} as CostTracker["agentCosts"];

  for (const agentId of agentIds) {
    const breakdown =
      record.agentCosts && typeof record.agentCosts === "object"
        ? (record.agentCosts as Partial<CostTracker["agentCosts"]>)[agentId]
        : undefined;
    agentCosts[agentId] = {
      inputTokens: normalizeNumber(breakdown?.inputTokens),
      outputTokens: normalizeNumber(breakdown?.outputTokens),
      reasoningTokens: normalizeNumber(breakdown?.reasoningTokens),
      estimatedUSD: normalizeNumber(breakdown?.estimatedUSD),
      pricingAvailable: Boolean(breakdown?.pricingAvailable),
    };
  }

  return {
    totalInputTokens: normalizeNumber(record.totalInputTokens),
    totalOutputTokens: normalizeNumber(record.totalOutputTokens),
    totalReasoningTokens: normalizeNumber(record.totalReasoningTokens),
    agentCosts,
    totalEstimatedUSD: normalizeNumber(record.totalEstimatedUSD),
  };
}

function normalizeWhisperStateValue(
  input: unknown,
  agentIds: AgentId[],
): CouncilState["whisperState"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<CouncilState["whisperState"]>;
  const messages = Array.isArray(record.messages)
    ? record.messages
        .map((message) => {
          if (!message || typeof message !== "object") return null;
          const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
          if (!isAgentId(message.from) || !isAgentId(message.to) || typeof message.type !== "string") {
            return null;
          }
          return {
            id: typeof message.id === "string" && message.id.length > 0 ? message.id : generateId("whisper"),
            from: message.from,
            to: message.to,
            type: message.type,
            payload: {
              ...(typeof (payload as { targetTopic?: unknown }).targetTopic === "string"
                ? { targetTopic: (payload as { targetTopic: string }).targetTopic }
                : {}),
              ...(typeof (payload as { proposedAction?: unknown }).proposedAction === "string"
                ? { proposedAction: (payload as { proposedAction: string }).proposedAction }
                : {}),
              ...(typeof (payload as { bidBonus?: unknown }).bidBonus === "number" &&
              Number.isFinite((payload as { bidBonus: number }).bidBonus)
                ? { bidBonus: (payload as { bidBonus: number }).bidBonus }
                : {}),
            },
            timestamp: normalizeNumber(message.timestamp, Date.now()),
          };
        })
        .filter((message): message is NonNullable<CouncilState["whisperState"]>["messages"][number] => Boolean(message))
    : [];

  const pendingBonuses = {} as NonNullable<CouncilState["whisperState"]>["pendingBonuses"];
  for (const agentId of agentIds) {
    pendingBonuses[agentId] = normalizeNumber(record.pendingBonuses?.[agentId]);
  }

  return { messages, pendingBonuses };
}

function normalizeConflictValue(input: unknown): CouncilState["conflict"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<CouncilState["conflict"]>;
  if (!isAgentId(record.agentPair?.[0]) || !isAgentId(record.agentPair?.[1])) return undefined;
  return {
    agentPair: [record.agentPair[0], record.agentPair[1]],
    conflictScore: normalizeNumber(record.conflictScore),
    threshold: normalizeNumber(record.threshold),
    lastUpdated: normalizeNumber(record.lastUpdated, Date.now()),
  };
}

function normalizeDuoLogueValue(input: unknown): CouncilState["duoLogue"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as NonNullable<CouncilState["duoLogue"]>;
  if (!isAgentId(record.participants?.[0]) || !isAgentId(record.participants?.[1])) return undefined;
  return {
    participants: [record.participants[0], record.participants[1]],
    remainingTurns: Math.max(0, normalizeNumber(record.remainingTurns)),
    otherAgentsBidding: Boolean(record.otherAgentsBidding),
  };
}

function normalizeImportedState(input: unknown): CouncilState | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<CouncilState>;
  const agents = Array.isArray(record.agents)
    ? record.agents
        .map((agent) => normalizeAgentConfig(agent))
        .filter((agent): agent is AgentConfig => Boolean(agent))
    : [];

  if (agents.length === 0) {
    return null;
  }

  const agentIds = agents.map((agent) => agent.id);
  const status =
    typeof record.status === "string" &&
    VALID_STATUSES.includes(record.status as (typeof VALID_STATUSES)[number])
      ? record.status
      : "idle";
  const normalizedStatus = status === "running" ? "paused" : status;

  return {
    id: typeof record.id === "string" && record.id.length > 0 ? record.id : generateId("council"),
    config: normalizeCouncilConfigValue(record.config),
    agents,
    messages: Array.isArray(record.messages)
      ? record.messages
          .map((message) => normalizeMessageValue(message))
          .filter((message): message is Message => Boolean(message))
      : [],
    currentTurn: Math.max(0, normalizeNumber(record.currentTurn)),
    totalCost: normalizeNumber(record.totalCost),
    costTracker: normalizeCostTrackerValue(record.costTracker, agentIds),
    conflict: normalizeConflictValue(record.conflict),
    duoLogue: normalizeDuoLogueValue(record.duoLogue),
    whisperState: normalizeWhisperStateValue(record.whisperState, agentIds),
    status: normalizedStatus,
    ...(typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
      ? { startedAt: record.startedAt }
      : {}),
    ...(normalizedStatus === "completed" &&
    typeof record.completedAt === "number" &&
    Number.isFinite(record.completedAt)
      ? { completedAt: record.completedAt }
      : {}),
  };
}

function getLastSpeakerFromMessages(messages: Message[]): AgentId | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const agentId = messages[index]?.agentId;
    if (isAgentId(agentId)) {
      return agentId;
    }
  }
  return undefined;
}

/**
 * Generate a unique ID for messages and councils
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Event types emitted by the council
 */
export type CouncilEvent =
  | { type: "council_started"; state: CouncilState }
  | { type: "turn_started"; agentId: AgentId; turnNumber: number }
  | { type: "message_chunk"; agentId: AgentId; content: string }
  | { type: "message_complete"; message: Message }
  | { type: "bidding_complete"; winner: AgentId; scores: Record<AgentId, number> }
  | { type: "whisper_sent"; message: WhisperMessage }
  | { type: "conflict_detected"; conflict: ConflictDetection }
  | { type: "duologue_started"; duoLogue: DuoLogue }
  | { type: "duologue_ended"; duoLogue: DuoLogue }
  | { type: "cost_updated"; costTracker: CostTracker }
  | { type: "oracle_result"; result: OracleResult }
  | { type: "council_paused"; state: CouncilState }
  | { type: "council_completed"; state: CouncilState }
  | { type: "error"; error: Error; agentId?: AgentId };

export type CouncilEventCallback = (event: CouncilEvent) => void;

/**
 * Council class - orchestrates the multi-agent debate
 */
export class Council {
  private state: CouncilState;
  private providerManager: ProviderManager;
  private eventCallback?: CouncilEventCallback;
  private isRunning = false;
  private abortController?: AbortController;
  private whisperManager: WhisperManager;
  private conflictDetector: ConflictDetector;
  private costTracker: CostTrackerEngine;
  private oracle: DuckDuckGoOracle;

  constructor(
    credentials: ProviderCredentials,
    config?: Partial<CouncilConfig>,
    agents?: Record<AgentId, AgentConfig>,
    options?: { transport?: Transport }
  ) {
    this.providerManager = new ProviderManager(credentials, { transport: options?.transport });

    const mergedConfig: CouncilConfig = {
      topic: config?.topic ?? "",
      maxTurns: config?.maxTurns ?? DEFAULT_COUNCIL_CONFIG.maxTurns,
      biddingTimeout: config?.biddingTimeout ?? DEFAULT_COUNCIL_CONFIG.biddingTimeout,
      budgetLimit: config?.budgetLimit ?? DEFAULT_COUNCIL_CONFIG.budgetLimit,
      autoMode: config?.autoMode ?? DEFAULT_COUNCIL_CONFIG.autoMode,
    };

    const mergedAgents = agents ?? DEFAULT_AGENTS;

    this.state = {
      id: generateId("council"),
      config: mergedConfig,
      agents: Object.values(mergedAgents),
      messages: [],
      currentTurn: 0,
      totalCost: 0,
      status: "idle",
    };

    const agentIds = this.state.agents.map((agent) => agent.id);
    this.whisperManager = new WhisperManager(agentIds);
    this.conflictDetector = new ConflictDetector();
    this.costTracker = new CostTrackerEngine(agentIds);
    this.oracle = new DuckDuckGoOracle();

    this.state.costTracker = this.costTracker.getState();
    this.state.whisperState = this.whisperManager.getState();
  }

  /**
   * Set the event callback for receiving council events
   */
  onEvent(callback: CouncilEventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Emit an event to the callback
   */
  private emit(event: CouncilEvent): void {
    this.eventCallback?.(event);
  }

  /**
   * Get the current state of the council
   */
  getState(): CouncilState {
    return cloneSnapshot(this.state);
  }

  /**
   * Start a new discussion with a topic
   */
  async start(topic: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Council is already running");
    }

    this.state.config.topic = topic;
    this.state.status = "running";
    this.state.startedAt = Date.now();
    this.state.completedAt = undefined;
    this.state.currentTurn = 0;
    this.state.messages = [];
    this.state.totalCost = 0;
    this.state.conflict = undefined;
    this.state.duoLogue = undefined;
    this.isRunning = true;
    this.abortController = new AbortController();

    const agentIds = this.state.agents.map((agent) => agent.id);
    this.whisperManager = new WhisperManager(agentIds);
    this.costTracker = new CostTrackerEngine(agentIds);
    this.state.whisperState = this.whisperManager.getState();
    this.state.costTracker = this.costTracker.getState();

    // Add the topic as a system message
    const topicMessage: Message = {
      id: generateId("msg"),
      agentId: "system",
      content: `Discussion Topic: ${topic}`,
      timestamp: Date.now(),
    };
    this.state.messages.push(topicMessage);

    this.emit({ type: "council_started", state: this.getState() });

    // In auto mode, start the discussion loop
    if (this.state.config.autoMode) {
      await this.runAutoMode();
    }
  }

  /**
   * Run the council in auto mode
   */
  private async runAutoMode(): Promise<void> {
    let lastSpeaker: AgentId | undefined = getLastSpeakerFromMessages(this.state.messages);
    let shouldComplete = false;
    let fatalError = false;

    while (
      this.isRunning &&
      this.state.currentTurn < this.state.config.maxTurns &&
      this.state.status === "running"
    ) {
      try {
        // Run bidding to select next speaker
        const agentIds = this.state.agents.map((a) => a.id);
        const whisperBonuses = this.whisperManager.consumeBonuses();
        this.state.whisperState = this.whisperManager.getState();
        const eligibleAgents =
          this.state.duoLogue && this.state.duoLogue.remainingTurns > 0
            ? this.state.duoLogue.participants
            : agentIds;

        const biddingResult = runBiddingRound(
          eligibleAgents,
          this.state.messages,
          this.state.config.topic,
          lastSpeaker,
          whisperBonuses
        );

        this.emit({
          type: "bidding_complete",
          winner: biddingResult.winner,
          scores: biddingResult.scores,
        });

        // Get the winning agent to speak
        const agent = this.state.agents.find((a) => a.id === biddingResult.winner);
        if (!agent) continue;

        const message = await this.generateAgentResponse(agent);
        if (!message) {
          fatalError = true;
          break;
        }

        lastSpeaker = agent.id;
        this.state.currentTurn++;

        if (this.state.duoLogue && this.state.duoLogue.remainingTurns > 0) {
          this.state.duoLogue.remainingTurns -= 1;
          if (this.state.duoLogue.remainingTurns <= 0) {
            const completed = this.state.duoLogue;
            this.state.duoLogue = undefined;
            this.state.conflict = undefined;
            this.emit({ type: "duologue_ended", duoLogue: completed });
          }
        }

        // Small delay between turns for readability
        await this.delay(500);
      } catch (error) {
        if (isAbortLikeError(error)) {
          break;
        }
        this.emit({ type: "error", error: error as Error });
        fatalError = true;
        break;
      }
    }

    if (
      !fatalError &&
      this.isRunning &&
      this.state.status === "running" &&
      this.state.currentTurn >= this.state.config.maxTurns
    ) {
      shouldComplete = true;
    }

    if (fatalError && this.state.status === "running") {
      shouldComplete = true;
    }

    if (shouldComplete) {
      this.completeCouncil();
    }
  }

  /**
   * Generate a response from a specific agent
   */
  async generateAgentResponse(agent: AgentConfig): Promise<Message | null> {
    const provider = this.providerManager.getProvider(agent.provider);
    if (!provider) {
      this.emit({
        type: "error",
        error: new Error(`Provider ${agent.provider} not configured`),
        agentId: agent.id,
      });
      return null;
    }

    this.emit({
      type: "turn_started",
      agentId: agent.id,
      turnNumber: this.state.currentTurn + 1,
    });

    // Format conversation history for the agent
    const messages = formatConversationHistory(
      agent,
      this.state.messages,
      this.state.config.topic
    );

    let fullContent = "";

    const streamCallback: StreamCallback = (chunk) => {
      if (!chunk.done) {
        fullContent += chunk.content;
        this.emit({
          type: "message_chunk",
          agentId: agent.id,
          content: chunk.content,
        });
      }
    };

    try {
      const result: CompletionResult = await provider.completeStream(
        agent,
        messages,
        streamCallback,
        {
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          signal: this.abortController?.signal,
        }
      );

      const content = fullContent || result.content;
      const message: Message = {
        id: generateId("msg"),
        agentId: agent.id,
        content,
        timestamp: Date.now(),
        tokens: result.tokens,
        metadata: {
          model: agent.model,
          latencyMs: result.latencyMs,
        },
      };

      this.state.messages.push(message);
      this.updateCost(agent.id, result.tokens, agent.model);
      this.evaluateConflict();
      this.emit({ type: "message_complete", message });

      return message;
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }
      this.emit({ type: "error", error: error as Error, agentId: agent.id });
      return null;
    }
  }

  /**
   * Manually trigger a specific agent to speak (for non-auto mode)
   */
  async triggerAgent(agentId: AgentId): Promise<Message | null> {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return this.generateAgentResponse(agent);
  }

  /**
   * Add a user message to the conversation
   */
  addUserMessage(content: string): Message {
    const message: Message = {
      id: generateId("msg"),
      agentId: "user",
      content,
      timestamp: Date.now(),
    };

    this.state.messages.push(message);
    return message;
  }

  private updateCost(agentId: AgentId, tokens: CompletionResult["tokens"], modelId: string): void {
    if (!tokens) return;
    this.costTracker.recordUsage(agentId, tokens, modelId);
    this.state.costTracker = this.costTracker.getState();
    this.state.totalCost = this.state.costTracker.totalEstimatedUSD;
    this.emit({ type: "cost_updated", costTracker: this.state.costTracker });
  }

  private evaluateConflict(): void {
    if (this.state.duoLogue && this.state.duoLogue.remainingTurns > 0) return;

    const agentIds = this.state.agents.map((agent) => agent.id);
    const conflict = this.conflictDetector.evaluate(this.state.messages, agentIds);
    this.state.conflict = conflict ?? undefined;

    if (conflict) {
      const duoLogue: DuoLogue = {
        participants: conflict.agentPair,
        remainingTurns: 3,
        otherAgentsBidding: false,
      };
      this.state.duoLogue = duoLogue;
      this.emit({ type: "conflict_detected", conflict });
      this.emit({ type: "duologue_started", duoLogue });
    }
  }

  /**
   * Send a whisper between agents (adds optional bid bonus)
   */
  sendWhisper(
    from: AgentId,
    to: AgentId,
    message: Omit<WhisperMessage, "id" | "from" | "to" | "timestamp">
  ): WhisperMessage {
    const whisper = this.whisperManager.sendWhisper(from, to, message);
    this.state.whisperState = this.whisperManager.getState();
    this.emit({ type: "whisper_sent", message: whisper });
    return whisper;
  }

  /**
   * Query the oracle tool for external verification
   */
  async queryOracle(query: string): Promise<OracleResult> {
    const result = await this.oracle.query(query);
    this.emit({ type: "oracle_result", result });
    return result;
  }

  /**
   * Pause the council
   */
  pause(): void {
    if (this.state.status === "running") {
      this.state.status = "paused";
      this.abortController?.abort();
      this.emit({ type: "council_paused", state: this.getState() });
    }
  }

  /**
   * Resume the council
   */
  async resume(): Promise<void> {
    if (this.state.status === "paused") {
      this.state.status = "running";
      this.abortController = new AbortController();
      if (this.state.config.autoMode) {
        await this.runAutoMode();
      }
    }
  }

  /**
   * Stop the council
   */
  stop(): void {
    this.isRunning = false;
    this.abortController?.abort();
    this.completeCouncil();
  }

  /**
   * Complete the council session
   */
  private completeCouncil(): void {
    if (this.state.status === "completed") {
      return;
    }
    this.state.status = "completed";
    this.state.completedAt = Date.now();
    this.isRunning = false;
    this.emit({ type: "council_completed", state: this.getState() });
  }

  /**
   * Update an agent's configuration
   */
  updateAgent(agentId: AgentId, updates: Partial<AgentConfig>): void {
    const agentIndex = this.state.agents.findIndex((a) => a.id === agentId);
    if (agentIndex === -1) {
      throw new Error(`Agent ${agentId} not found`);
    }

    this.state.agents[agentIndex] = {
      ...this.state.agents[agentIndex]!,
      ...updates,
    };
  }

  /**
   * Update provider credentials
   */
  updateCredentials(credentials: Partial<ProviderCredentials>): void {
    for (const [provider, cred] of Object.entries(credentials)) {
      if (cred?.apiKey) {
        this.providerManager.setProvider(
          provider as AgentConfig["provider"],
          cred.apiKey,
          cred.baseUrl
        );
      }
    }
  }

  /**
   * Helper to create a delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get conversation transcript
   */
  getTranscript(): string {
    return this.state.messages
      .map((m) => {
        const speaker = m.agentId === "system" ? "SYSTEM" : m.agentId.toUpperCase();
        return `[${speaker}]: ${m.content}`;
      })
      .join("\n\n");
  }

  /**
   * Export state for persistence
   */
  exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * Import state from persistence
   */
  importState(stateJson: string): void {
    const imported = normalizeImportedState(JSON.parse(stateJson));
    if (!imported) {
      throw new Error("Invalid council state payload");
    }
    this.state = imported;
    this.isRunning = false;
    this.abortController = undefined;

    const agentIds = this.state.agents.map((agent) => agent.id);
    this.whisperManager = new WhisperManager(agentIds);
    if (this.state.whisperState) {
      this.whisperManager.loadState(this.state.whisperState);
    }

    this.costTracker = new CostTrackerEngine(agentIds);
    if (this.state.costTracker) {
      this.costTracker.loadState(this.state.costTracker);
    }
  }
}
