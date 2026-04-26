/**
 * @fileoverview Conversation Memory System
 * Implements a sliding window approach for agent context management.
 *
 * Key features:
 * - 20-message sliding window (configurable)
 * - Priority-based message selection
 * - Engagement tracking across messages
 * - Message metadata for cross-referencing
 */

import type { AgentId, Message } from "@socratic-council/shared";

// =============================================================================
// TYPES
// =============================================================================

export interface MessageWithContext extends Message {
  /** Agents who quoted this message */
  quotedBy: AgentId[];
  /** Agents who reacted to this message, by reaction type */
  reactedBy: Record<string, AgentId[]>;
  /** How much this message was engaged with (0-100) */
  engagementScore: number;
  /** Optional summary for older messages */
  summary?: string;
}

export interface EngagementDebt {
  /** Agent who owes engagement */
  debtor: AgentId;
  /** Agent who made the unreplied point */
  creditor: AgentId;
  /** The message that needs response */
  messageId: string;
  /** Reason for the debt */
  reason: "direct_question" | "mentioned_by_name" | "challenged" | "unanswered";
  /** Higher = more urgent to respond (0-100) */
  priority: number;
}

export interface ConversationContext {
  /** Recent messages (sliding window) */
  recentMessages: MessageWithContext[];
  /** AI-generated summary of older messages (optional) */
  summary?: string;
  /** Current discussion thread/sub-topic */
  topicThread: string;
  /** Activity count per agent */
  agentMentions: Record<AgentId, number>;
  /** Who owes engagement to whom */
  engagementDebt: EngagementDebt[];
  /** Project-level evidence available to all sessions in this project */
  projectEvidence: ProjectEvidence[];
}

export interface ProjectEvidence {
  /** Unique identifier for the evidence entry */
  id: string;
  /** Display name of the evidence file */
  name: string;
  /** Brief text summary of the evidence content */
  summary: string;
}

export interface MemoryConfig {
  /** Number of messages to keep in context (default: 20) */
  windowSize: number;
  /** Whether to prioritize messages that mention the current agent */
  prioritizeAgentMentions: boolean;
  /** Whether to track engagement debt */
  trackEngagementDebt: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: MemoryConfig = {
  windowSize: 20,
  prioritizeAgentMentions: true,
  trackEngagementDebt: true,
};

const AGENT_NAMES: Record<AgentId, string> = {
  george: "George",
  cathy: "Cathy",
  grace: "Grace",
  douglas: "Douglas",
  kate: "Kate",
  quinn: "Quinn",
  mary: "Mary",
  zara: "Zara",
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a message mentions a specific agent by name
 */
function mentionsAgent(content: string, agentId: AgentId): boolean {
  const name = AGENT_NAMES[agentId];
  if (!name) return false;

  // Case-insensitive check for agent name
  const regex = new RegExp(`\\b${name}\\b`, "i");
  return regex.test(content);
}

/**
 * Check if a message contains a direct question to a specific target agent.
 *
 * Fix 5.5: tightened from "any '?' anywhere" to "agent name on the same line
 * as a question token". The previous predicate fired on every parenthetical
 * "?" or rhetorical aside, distorting bidding via spurious priority-90 debts.
 */
function containsDirectQuestion(content: string, targetAgent: AgentId): boolean {
  const name = AGENT_NAMES[targetAgent];
  if (!name) return false;
  // Must mention the agent.
  const nameRe = new RegExp(`\\b${name}\\b`, "i");
  if (!nameRe.test(content)) return false;
  // And the same line should look like a direct question — either a vocative
  // address ("George, what about ...") or a wh-/aux question pattern within
  // ~120 chars of the name.
  const lines = content.split(/\r?\n/);
  const QUESTION = /\b(what|how|why|when|where|who|which|would|could|should|do you|does|is it|are you|isn't|aren't|won't|can you)\b/i;
  for (const line of lines) {
    if (!nameRe.test(line)) continue;
    if (line.includes("?")) return true;
    if (QUESTION.test(line)) return true;
    // Vocative form: "George, ..." or "George:" at start of line.
    if (new RegExp(`^\\s*${name}\\s*[,:-]`, "i").test(line)) return true;
  }
  return false;
}

/**
 * Check if a message challenges another agent. Fix 5.8: broadened to catch
 * common natural-language pushback that the old narrow regex set missed.
 */
function containsChallenge(content: string, targetAgent: AgentId): boolean {
  const name = AGENT_NAMES[targetAgent];
  if (!name) return false;

  const challengePatterns = [
    new RegExp(`disagree\\s+with\\s+${name}`, "i"),
    new RegExp(`${name}['s]*\\s+(argument|point|claim).*(?:weak|wrong|flawed|mistaken|misguided)`, "i"),
    new RegExp(`challenge\\s+${name}`, "i"),
    new RegExp(`${name}.*\\b(?:mistaken|wrong|flawed|misguided|missed)\\b`, "i"),
    // "you're wrong, X" / "X, you're wrong" / "no, X, ..."
    new RegExp(`\\byou(?:'re| are)\\s+(?:wrong|mistaken|missing)\\b.*\\b${name}\\b`, "i"),
    new RegExp(`\\b${name}\\b.*\\byou(?:'re| are)\\s+(?:wrong|mistaken|missing)\\b`, "i"),
    new RegExp(`^\\s*no[,.]?\\s*${name}\\b`, "im"),
    // "X is wrong about Y" / "X has it backwards"
    new RegExp(`\\b${name}\\b\\s+(?:is|was)\\s+(?:wrong|mistaken)`, "i"),
    new RegExp(`\\b${name}\\b\\s+(?:has|got)\\s+(?:it|that)\\s+backwards`, "i"),
  ];

  return challengePatterns.some((pattern) => pattern.test(content));
}

/**
 * Calculate engagement score for a message based on quotes and reactions
 */
function calculateEngagementScore(message: MessageWithContext): number {
  let score = 0;

  // Points for being quoted
  score += message.quotedBy.length * 15;

  // Points for reactions
  const totalReactions = Object.values(message.reactedBy).reduce(
    (sum, agents) => sum + agents.length,
    0,
  );
  score += totalReactions * 5;

  // Cap at 100
  return Math.min(score, 100);
}

// =============================================================================
// MEMORY MANAGER CLASS
// =============================================================================

export class ConversationMemoryManager {
  private messages: MessageWithContext[] = [];
  private config: MemoryConfig;
  private engagementDebts: EngagementDebt[] = [];
  private agentMentions: Record<AgentId, number>;
  private topic: string = "";
  private projectEvidence: ProjectEvidence[] = [];
  /**
   * Optional LLM-produced summary covering messages that have rolled off the
   * sliding window. Populated by an external summarizer pass — see
   * `summarize.ts`. `null` means no summary is available yet; the placeholder
   * in `generateSummaryIfNeeded` is returned in that case.
   */
  private sessionSummary: string | null = null;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.agentMentions = {
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

  /**
   * Set the discussion topic
   */
  setTopic(topic: string): void {
    this.topic = topic;
  }

  /**
   * Set project-level evidence entries for cross-session context.
   * When set, agents will be aware of dossier items from the parent project.
   */
  setProjectEvidence(evidence: ProjectEvidence[]): void {
    this.projectEvidence = evidence;
  }

  /**
   * Get current project evidence entries.
   */
  getProjectEvidence(): ProjectEvidence[] {
    return this.projectEvidence;
  }

  /**
   * Add a new message to the memory
   */
  addMessage(message: Message): void {
    const enhancedMessage: MessageWithContext = {
      ...message,
      quotedBy: [],
      reactedBy: {},
      engagementScore: 0,
    };

    this.messages.push(enhancedMessage);

    // Track agent mentions
    if (message.agentId !== "system" && message.agentId !== "user" && message.agentId !== "tool") {
      this.agentMentions[message.agentId as AgentId]++;
    }

    // Fix 5.3: when an agent speaks AT ALL, clear debts they owe to anyone
    // they mention by name in this message. Previously the only clearing
    // path was `recordQuote` (i.e. requiring a literal @quote token), so a
    // verbal response carried a debt forward indefinitely.
    if (
      message.agentId !== "system" &&
      message.agentId !== "user" &&
      message.agentId !== "tool"
    ) {
      const speaker = message.agentId as AgentId;
      const remaining: EngagementDebt[] = [];
      for (const debt of this.engagementDebts) {
        if (
          debt.debtor === speaker &&
          mentionsAgent(message.content, debt.creditor)
        ) {
          continue; // resolved by this verbal response
        }
        remaining.push(debt);
      }
      this.engagementDebts = remaining;
    }

    // Update engagement debts
    if (this.config.trackEngagementDebt) {
      this.updateEngagementDebts(enhancedMessage);
    }

    // Fix 5.6: cap the debt list and apply mild priority decay so old
    // entries age out instead of accumulating forever across long sessions.
    if (this.engagementDebts.length > 0) {
      // Decay by 1 priority per added message — generous enough that a
      // direct-question debt (priority 90) survives ~50 messages, but
      // a stale "mentioned by name" (priority 60) fades within ~40.
      this.engagementDebts = this.engagementDebts
        .map((d) => ({ ...d, priority: Math.max(0, d.priority - 1) }))
        .filter((d) => d.priority > 0);
      if (this.engagementDebts.length > 64) {
        this.engagementDebts = this.engagementDebts
          .sort((a, b) => b.priority - a.priority)
          .slice(0, 64);
      }
    }
  }

  /**
   * Record that an agent quoted a specific message
   */
  recordQuote(messageId: string, quotingAgent: AgentId): void {
    const message = this.messages.find((m) => m.id === messageId);
    if (message && !message.quotedBy.includes(quotingAgent)) {
      message.quotedBy.push(quotingAgent);
      message.engagementScore = calculateEngagementScore(message);

      // Clear engagement debt if the quoting agent owed it
      const creditor = message.agentId;
      if (creditor !== "system" && creditor !== "user" && creditor !== "tool") {
        this.clearEngagementDebt(quotingAgent, creditor, messageId);
      }
    }
  }

  /**
   * Record that an agent reacted to a specific message
   */
  recordReaction(messageId: string, reactingAgent: AgentId, reactionType: string): void {
    const message = this.messages.find((m) => m.id === messageId);
    if (message) {
      if (!message.reactedBy[reactionType]) {
        message.reactedBy[reactionType] = [];
      }
      if (!message.reactedBy[reactionType].includes(reactingAgent)) {
        message.reactedBy[reactionType].push(reactingAgent);
        message.engagementScore = calculateEngagementScore(message);
      }
    }
  }

  /**
   * Update engagement debts based on a new message
   */
  private updateEngagementDebts(message: MessageWithContext): void {
    const speakerId = message.agentId;
    if (speakerId === "system" || speakerId === "user" || speakerId === "tool") return;

    const agentIds: AgentId[] = [
      "george",
      "cathy",
      "grace",
      "douglas",
      "kate",
      "quinn",
      "mary",
      "zara",
    ];

    for (const targetAgent of agentIds) {
      if (targetAgent === speakerId) continue;

      // Check if this message creates a debt for the target agent
      let debtReason: EngagementDebt["reason"] | null = null;
      let priority = 50;

      if (mentionsAgent(message.content, targetAgent)) {
        if (containsDirectQuestion(message.content, targetAgent)) {
          debtReason = "direct_question";
          priority = 90;
        } else if (containsChallenge(message.content, targetAgent)) {
          debtReason = "challenged";
          priority = 85;
        } else {
          debtReason = "mentioned_by_name";
          priority = 60;
        }
      }

      if (debtReason) {
        // Check if this debt already exists
        const existingDebt = this.engagementDebts.find(
          (d) => d.debtor === targetAgent && d.messageId === message.id,
        );

        if (!existingDebt) {
          this.engagementDebts.push({
            debtor: targetAgent,
            creditor: speakerId as AgentId,
            messageId: message.id,
            reason: debtReason,
            priority,
          });
        }
      }
    }
  }

  /**
   * Clear an engagement debt
   */
  private clearEngagementDebt(debtor: AgentId, creditor: AgentId, messageId: string): void {
    this.engagementDebts = this.engagementDebts.filter(
      (d) => !(d.debtor === debtor && d.creditor === creditor && d.messageId === messageId),
    );
  }

  /**
   * Get engagement debts for a specific agent
   */
  getEngagementDebts(agentId: AgentId): EngagementDebt[] {
    return this.engagementDebts
      .filter((d) => d.debtor === agentId)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Build conversation context for an agent
   */
  buildContext(currentAgent: AgentId): ConversationContext {
    const windowSize = this.config.windowSize;
    let selectedMessages: MessageWithContext[];

    if (this.messages.length <= windowSize) {
      // All messages fit in window
      selectedMessages = [...this.messages];
    } else {
      // Need to select most relevant messages
      selectedMessages = this.selectRelevantMessages(currentAgent, windowSize);
    }

    return {
      recentMessages: selectedMessages,
      summary: this.generateSummaryIfNeeded(),
      topicThread: this.topic,
      agentMentions: { ...this.agentMentions },
      engagementDebt: this.getEngagementDebts(currentAgent),
      projectEvidence: this.projectEvidence,
    };
  }

  /**
   * Select the most relevant messages for an agent's context
   */
  private selectRelevantMessages(currentAgent: AgentId, windowSize: number): MessageWithContext[] {
    // Always include the most recent messages
    const recentCount = Math.floor(windowSize * 0.7); // 70% recent
    const priorityCount = windowSize - recentCount; // 30% priority-based

    const allMessages = [...this.messages];
    const recentMessages = allMessages.slice(-recentCount);
    const olderMessages = allMessages.slice(0, -recentCount);

    if (olderMessages.length === 0 || priorityCount === 0) {
      return recentMessages;
    }

    // Fix 5.7: reserve at least one slot per other council agent that has
    // no recent presence in `recentMessages`. This prevents the prompt from
    // referring to "George said" when George has been silent for the last
    // 14 messages (and isn't in the visible window).
    const reservedMessages: MessageWithContext[] = [];
    const reservedSet = new Set<string>();
    const recentSpeakers = new Set(recentMessages.map((m) => m.agentId));
    const allCouncilIds: AgentId[] = [
      "george",
      "cathy",
      "grace",
      "douglas",
      "kate",
      "quinn",
      "mary",
      "zara",
    ];
    for (const id of allCouncilIds) {
      if (id === currentAgent) continue;
      if (recentSpeakers.has(id)) continue;
      // Find the LATEST older message from this agent.
      for (let i = olderMessages.length - 1; i >= 0; i -= 1) {
        const m = olderMessages[i]!;
        if (m.agentId === id) {
          reservedMessages.push(m);
          reservedSet.add(m.id);
          break;
        }
      }
      // Don't blow the priority budget; reserve up to half of the slots.
      if (reservedMessages.length >= Math.floor(priorityCount / 2)) break;
    }

    // Score older messages by relevance to current agent (skip already-reserved).
    const scoredOlder = olderMessages
      .filter((m) => !reservedSet.has(m.id))
      .map((msg) => {
        let score = 0;

        // Boost messages that mention this agent
        if (this.config.prioritizeAgentMentions && mentionsAgent(msg.content, currentAgent)) {
          score += 50;
        }

        // Boost messages from agents this agent hasn't responded to
        const hasResponseFromAgent = recentMessages.some(
          (m) => m.agentId === currentAgent && m.quotedBy.includes(msg.agentId as AgentId),
        );
        if (
          !hasResponseFromAgent &&
          msg.agentId !== "system" &&
          msg.agentId !== "user" &&
          msg.agentId !== "tool"
        ) {
          score += 30;
        }

        // Boost highly engaged messages
        score += msg.engagementScore * 0.3;

        return { message: msg, score };
      });

    // Sort by score and take remaining priority slots after reservation.
    const remainingBudget = Math.max(0, priorityCount - reservedMessages.length);
    scoredOlder.sort((a, b) => b.score - a.score);
    const scoredPicks = scoredOlder.slice(0, remainingBudget).map((s) => s.message);

    // Combine and sort by timestamp
    const combined = [...reservedMessages, ...scoredPicks, ...recentMessages];
    combined.sort((a, b) => a.timestamp - b.timestamp);

    return combined;
  }

  /**
   * Generate a summary of older messages if needed
   * (Returns placeholder - actual summarization would require LLM call)
   *
   * Prefers an LLM-produced summary injected via `setSessionSummary` when
   * available (from the summarizer pass in `summarize.ts` — see wave 3.3).
   * Falls back to a neutral placeholder when the window has overflowed and
   * no real summary has been computed yet.
   */
  private generateSummaryIfNeeded(): string | undefined {
    if (this.messages.length <= this.config.windowSize) {
      return undefined;
    }

    if (this.sessionSummary && this.sessionSummary.trim() !== "") {
      return this.sessionSummary;
    }

    // Fix 5.4: language-neutral placeholder. The previous English-only
    // sentence leaked into non-English debates' prompts (Chinese, Japanese,
    // Arabic, …) and broke the language-matching cue. The proper long-term
    // fix is wiring `summarizeOlderMessages` (5.1a); until then a minimal
    // count is the safest hint.
    const excludedCount = this.messages.length - this.config.windowSize;
    return `[${excludedCount} earlier messages omitted from this window.]`;
  }

  /**
   * Inject an LLM-generated summary for older messages. Driven by the
   * summarizer pass in `summarize.ts`; stored on the memory manager so the
   * next `buildContext()` includes it at the top of the agent's prompt.
   * Passing an empty string clears the override.
   */
  setSessionSummary(summary: string | null): void {
    this.sessionSummary = summary && summary.trim() !== "" ? summary.trim() : null;
  }

  /** Read the currently-active session summary (null when none is set). */
  getSessionSummary(): string | null {
    return this.sessionSummary;
  }

  /**
   * Format messages for inclusion in an agent's prompt
   */
  formatForPrompt(context: ConversationContext): string {
    const lines: string[] = [];

    // Add summary if available
    if (context.summary) {
      lines.push(`## EARLIER CONTEXT\n${context.summary}\n`);
    }

    // Add recent messages with metadata
    lines.push("## CONVERSATION HISTORY\n");

    for (const msg of context.recentMessages) {
      if (msg.agentId === "system") continue;

      const speaker =
        msg.agentId === "user" ? "User" : AGENT_NAMES[msg.agentId as AgentId] || msg.agentId;
      const quotedInfo =
        msg.quotedBy.length > 0
          ? ` [Quoted by: ${msg.quotedBy.map((id) => AGENT_NAMES[id] || id).join(", ")}]`
          : "";

      lines.push(`**${speaker}** (id: ${msg.id})${quotedInfo}:`);
      lines.push(msg.content);
      lines.push("");
    }

    // Add engagement requirements if there are debts
    if (context.engagementDebt.length > 0) {
      lines.push("## YOUR REQUIRED ENGAGEMENT THIS TURN\n");

      const topDebts = context.engagementDebt.slice(0, 3);
      for (const debt of topDebts) {
        const creditorName = AGENT_NAMES[debt.creditor];
        const reasonText = {
          direct_question: `${creditorName} asked you a direct question`,
          mentioned_by_name: `${creditorName} mentioned you by name`,
          challenged: `${creditorName} challenged your position`,
          unanswered: `${creditorName}'s point hasn't been addressed`,
        }[debt.reason];

        lines.push(`- **MUST respond to** ${creditorName} (${debt.messageId}): ${reasonText}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Get all messages (for debugging/export)
   */
  getAllMessages(): MessageWithContext[] {
    return [...this.messages];
  }

  /**
   * Reset the memory
   */
  reset(): void {
    this.messages = [];
    this.engagementDebts = [];
    this.agentMentions = {
      george: 0,
      cathy: 0,
      grace: 0,
      douglas: 0,
      kate: 0,
      quinn: 0,
      mary: 0,
      zara: 0,
    };
    this.topic = "";
  }
}

// Export default instance factory
export function createMemoryManager(config?: Partial<MemoryConfig>): ConversationMemoryManager {
  return new ConversationMemoryManager(config);
}
