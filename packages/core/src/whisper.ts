/**
 * @fileoverview Whisper protocol manager
 * Handles private inter-agent messages and bid bonuses.
 */

import type { AgentId, WhisperMessage, WhisperState } from "@socratic-council/shared";

export class WhisperManager {
  private state: WhisperState;

  constructor(agentIds: AgentId[]) {
    const pendingBonuses: WhisperState["pendingBonuses"] = {} as Record<AgentId, number>;
    for (const agentId of agentIds) {
      pendingBonuses[agentId] = 0;
    }
    this.state = {
      messages: [],
      pendingBonuses,
    };
  }

  getState(): WhisperState {
    return {
      messages: [...this.state.messages],
      pendingBonuses: { ...this.state.pendingBonuses },
    };
  }

  loadState(state: WhisperState): void {
    this.state = {
      messages: [...state.messages],
      pendingBonuses: { ...state.pendingBonuses },
    };
  }

  sendWhisper(
    from: AgentId,
    to: AgentId,
    message: Omit<WhisperMessage, "id" | "from" | "to" | "timestamp">
  ): WhisperMessage {
    const whisper: WhisperMessage = {
      ...message,
      id: `whisper_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      from,
      to,
      timestamp: Date.now(),
    };

    this.state.messages.push(whisper);

    if (typeof whisper.payload.bidBonus === "number") {
      const current = this.state.pendingBonuses[to] ?? 0;
      this.state.pendingBonuses[to] = Math.min(20, Math.max(0, current + whisper.payload.bidBonus));
    }

    return whisper;
  }

  consumeBonuses(): Record<AgentId, number> {
    const bonuses = { ...this.state.pendingBonuses };
    for (const agentId of Object.keys(this.state.pendingBonuses) as AgentId[]) {
      this.state.pendingBonuses[agentId] = 0;
    }
    return bonuses;
  }
}
