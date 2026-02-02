/**
 * @fileoverview Council orchestration - manages the debate flow
 * Coordinates agents, bidding, and message streaming
 */

import type {
  AgentConfig,
  AgentId,
  CouncilConfig,
  CouncilState,
  Message,
  ProviderCredentials,
} from "@socratic-council/shared";
import { DEFAULT_AGENTS, DEFAULT_COUNCIL_CONFIG } from "@socratic-council/shared";
import {
  type CompletionResult,
  ProviderManager,
  type StreamCallback,
  formatConversationHistory,
} from "@socratic-council/sdk";
import { runBiddingRound } from "./bidding.js";

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

  constructor(
    credentials: ProviderCredentials,
    config?: Partial<CouncilConfig>,
    agents?: Record<AgentId, AgentConfig>
  ) {
    this.providerManager = new ProviderManager(credentials);

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
    return { ...this.state };
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
    this.state.currentTurn = 0;
    this.state.messages = [];
    this.isRunning = true;
    this.abortController = new AbortController();

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
    let lastSpeaker: AgentId | undefined;

    while (
      this.isRunning &&
      this.state.currentTurn < this.state.config.maxTurns &&
      this.state.status === "running"
    ) {
      try {
        // Run bidding to select next speaker
        const agentIds = this.state.agents.map((a) => a.id);
        const biddingResult = runBiddingRound(
          agentIds,
          this.state.messages,
          this.state.config.topic,
          lastSpeaker
        );

        this.emit({
          type: "bidding_complete",
          winner: biddingResult.winner,
          scores: biddingResult.scores,
        });

        // Get the winning agent to speak
        const agent = this.state.agents.find((a) => a.id === biddingResult.winner);
        if (!agent) continue;

        await this.generateAgentResponse(agent);
        lastSpeaker = agent.id;
        this.state.currentTurn++;

        // Small delay between turns for readability
        await this.delay(500);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          break;
        }
        this.emit({ type: "error", error: error as Error });
        break;
      }
    }

    this.completeCouncil();
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
        { temperature: agent.temperature, maxTokens: agent.maxTokens }
      );

      const message: Message = {
        id: generateId("msg"),
        agentId: agent.id,
        content: fullContent,
        timestamp: Date.now(),
        tokens: result.tokens,
        metadata: {
          model: agent.model,
          latencyMs: result.latencyMs,
        },
      };

      this.state.messages.push(message);
      this.emit({ type: "message_complete", message });

      return message;
    } catch (error) {
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

  /**
   * Pause the council
   */
  pause(): void {
    if (this.state.status === "running") {
      this.state.status = "paused";
      this.emit({ type: "council_paused", state: this.getState() });
    }
  }

  /**
   * Resume the council
   */
  async resume(): Promise<void> {
    if (this.state.status === "paused") {
      this.state.status = "running";
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
        this.providerManager.setProvider(provider as AgentConfig["provider"], cred.apiKey);
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
    const imported = JSON.parse(stateJson) as CouncilState;
    this.state = imported;
  }
}
