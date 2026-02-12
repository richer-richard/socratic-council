/**
 * @fileoverview Fairness manager for balanced turn-taking
 * Ensures all agents speak roughly equally within a sliding window.
 */

import type { AgentId } from "@socratic-council/shared";

export interface FairnessAdjustment {
  agentId: AgentId;
  adjustment: number;
  reason: "just_spoke" | "overrepresented" | "underrepresented" | "normal";
}

export class FairnessManager {
  private recentSpeakers: AgentId[] = [];
  private windowSize: number;
  private maxSpeaksInWindow: number;

  constructor(windowSize = 10, maxSpeaksInWindow = 3) {
    this.windowSize = windowSize;
    this.maxSpeaksInWindow = maxSpeaksInWindow;
  }

  recordSpeaker(agentId: AgentId): void {
    this.recentSpeakers.push(agentId);
    if (this.recentSpeakers.length > this.windowSize) {
      this.recentSpeakers = this.recentSpeakers.slice(-this.windowSize);
    }
  }

  getWindowSize(): number {
    return this.windowSize;
  }

  getMaxSpeaksInWindow(): number {
    return this.maxSpeaksInWindow;
  }

  getWindowFilled(): number {
    return this.recentSpeakers.length;
  }

  getSpeakingCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of this.recentSpeakers) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }

  calculateAdjustments(agents: AgentId[]): FairnessAdjustment[] {
    const counts = this.getSpeakingCounts();
    const windowFilled = this.recentSpeakers.length;
    const lastSpeaker = this.recentSpeakers.length > 0
      ? this.recentSpeakers[this.recentSpeakers.length - 1]
      : null;

    return agents.map((agentId) => {
      const speakCount = counts[agentId] ?? 0;

      // Last speaker gets heavily penalized to prevent back-to-back
      if (agentId === lastSpeaker) {
        return { agentId, adjustment: -100, reason: "just_spoke" as const };
      }

      // Agents who spoke >= max times in the window are almost excluded
      if (speakCount >= this.maxSpeaksInWindow) {
        return { agentId, adjustment: -80, reason: "overrepresented" as const };
      }

      // Once the window has enough data, boost underrepresented agents
      if (windowFilled >= 5) {
        if (speakCount === 0) {
          return { agentId, adjustment: 60, reason: "underrepresented" as const };
        }
        if (speakCount <= 1) {
          return { agentId, adjustment: 30, reason: "underrepresented" as const };
        }
      }

      return { agentId, adjustment: 0, reason: "normal" as const };
    });
  }

  reset(): void {
    this.recentSpeakers = [];
  }
}
