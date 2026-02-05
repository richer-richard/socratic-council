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
 * Check if a message contains a direct question
 */
function containsDirectQuestion(content: string): boolean {
  // Check for question marks and question-like patterns
  return content.includes("?") || 
    /\b(what|how|why|when|where|who|which|would|could|should|do you|does|is it|are you)\b/i.test(content);
}

/**
 * Check if a message challenges another agent
 */
function containsChallenge(content: string, targetAgent: AgentId): boolean {
  const name = AGENT_NAMES[targetAgent];
  if (!name) return false;
  
  const challengePatterns = [
    new RegExp(`disagree\\s+with\\s+${name}`, "i"),
    new RegExp(`${name}['s]*\\s+(argument|point|claim).*(?:weak|wrong|flawed)`, "i"),
    new RegExp(`challenge\\s+${name}`, "i"),
    new RegExp(`${name}.*mistaken`, "i"),
  ];
  
  return challengePatterns.some(pattern => pattern.test(content));
}

/**
 * Calculate engagement score for a message based on quotes and reactions
 */
function calculateEngagementScore(message: MessageWithContext): number {
  let score = 0;
  
  // Points for being quoted
  score += message.quotedBy.length * 15;
  
  // Points for reactions
  const totalReactions = Object.values(message.reactedBy)
    .reduce((sum, agents) => sum + agents.length, 0);
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

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.agentMentions = {
      george: 0,
      cathy: 0,
      grace: 0,
      douglas: 0,
      kate: 0,
    };
  }

  /**
   * Set the discussion topic
   */
  setTopic(topic: string): void {
    this.topic = topic;
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

    // Update engagement debts
    if (this.config.trackEngagementDebt) {
      this.updateEngagementDebts(enhancedMessage);
    }
  }

  /**
   * Record that an agent quoted a specific message
   */
  recordQuote(messageId: string, quotingAgent: AgentId): void {
    const message = this.messages.find(m => m.id === messageId);
    if (message && !message.quotedBy.includes(quotingAgent)) {
      message.quotedBy.push(quotingAgent);
      message.engagementScore = calculateEngagementScore(message);
      
      // Clear engagement debt if the quoting agent owed it
      this.clearEngagementDebt(quotingAgent, message.agentId as AgentId, messageId);
    }
  }

  /**
   * Record that an agent reacted to a specific message
   */
  recordReaction(messageId: string, reactingAgent: AgentId, reactionType: string): void {
    const message = this.messages.find(m => m.id === messageId);
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

    const agentIds: AgentId[] = ["george", "cathy", "grace", "douglas", "kate"];

    for (const targetAgent of agentIds) {
      if (targetAgent === speakerId) continue;

      // Check if this message creates a debt for the target agent
      let debtReason: EngagementDebt["reason"] | null = null;
      let priority = 50;

      if (mentionsAgent(message.content, targetAgent)) {
        if (containsDirectQuestion(message.content)) {
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
          d => d.debtor === targetAgent && d.messageId === message.id
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
      d => !(d.debtor === debtor && d.creditor === creditor && d.messageId === messageId)
    );
  }

  /**
   * Get engagement debts for a specific agent
   */
  getEngagementDebts(agentId: AgentId): EngagementDebt[] {
    return this.engagementDebts
      .filter(d => d.debtor === agentId)
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

    // Score older messages by relevance to current agent
    const scoredOlder = olderMessages.map(msg => {
      let score = 0;

      // Boost messages that mention this agent
      if (this.config.prioritizeAgentMentions && mentionsAgent(msg.content, currentAgent)) {
        score += 50;
      }

      // Boost messages from agents this agent hasn't responded to
      const hasResponseFromAgent = recentMessages.some(
        m => m.agentId === currentAgent && 
             m.quotedBy.includes(msg.agentId as AgentId)
      );
      if (!hasResponseFromAgent && msg.agentId !== "system" && msg.agentId !== "user" && msg.agentId !== "tool") {
        score += 30;
      }

      // Boost highly engaged messages
      score += msg.engagementScore * 0.3;

      return { message: msg, score };
    });

    // Sort by score and take top priority messages
    scoredOlder.sort((a, b) => b.score - a.score);
    const priorityMessages = scoredOlder.slice(0, priorityCount).map(s => s.message);

    // Combine and sort by timestamp
    const combined = [...priorityMessages, ...recentMessages];
    combined.sort((a, b) => a.timestamp - b.timestamp);

    return combined;
  }

  /**
   * Generate a summary of older messages if needed
   * (Returns placeholder - actual summarization would require LLM call)
   */
  private generateSummaryIfNeeded(): string | undefined {
    if (this.messages.length <= this.config.windowSize) {
      return undefined;
    }

    const excludedCount = this.messages.length - this.config.windowSize;
    return `[${excludedCount} earlier messages summarized: Discussion has covered various perspectives on the topic, with contributions from multiple council members.]`;
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
      
      const speaker = msg.agentId === "user" ? "User" : AGENT_NAMES[msg.agentId as AgentId] || msg.agentId;
      const quotedInfo = msg.quotedBy.length > 0 
        ? ` [Quoted by: ${msg.quotedBy.map(id => AGENT_NAMES[id]).join(", ")}]` 
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
    };
    this.topic = "";
  }
}

// Export default instance factory
export function createMemoryManager(config?: Partial<MemoryConfig>): ConversationMemoryManager {
  return new ConversationMemoryManager(config);
}
