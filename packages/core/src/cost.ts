/**
 * @fileoverview Cost tracking utilities
 * Tracks per-agent token usage and estimated USD cost.
 */

import type {
  AgentCostBreakdown,
  AgentId,
  CostTracker,
  ModelInfo,
} from "@socratic-council/shared";
import { getModelInfo } from "@socratic-council/shared";

interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
}

function estimateUsd(usage: TokenUsage, modelInfo?: ModelInfo): { usd: number; pricingAvailable: boolean } {
  const pricing = modelInfo?.pricing;
  const hasPricing = Boolean(
    pricing && (pricing.inputCostPer1M || pricing.outputCostPer1M || pricing.reasoningCostPer1M)
  );

  if (!hasPricing) {
    return { usd: 0, pricingAvailable: false };
  }

  const inputCost = ((usage.input || 0) / 1_000_000) * (pricing?.inputCostPer1M ?? 0);
  const outputCost = ((usage.output || 0) / 1_000_000) * (pricing?.outputCostPer1M ?? 0);
  const reasoningCost =
    ((usage.reasoning || 0) / 1_000_000) * (pricing?.reasoningCostPer1M ?? 0);

  return { usd: inputCost + outputCost + reasoningCost, pricingAvailable: true };
}

function createEmptyBreakdown(): AgentCostBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedUSD: 0,
    pricingAvailable: false,
  };
}

export class CostTrackerEngine {
  private state: CostTracker;

  constructor(agentIds: AgentId[]) {
    const agentCosts = {} as Record<AgentId, AgentCostBreakdown>;
    for (const agentId of agentIds) {
      agentCosts[agentId] = createEmptyBreakdown();
    }

    this.state = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      agentCosts,
      totalEstimatedUSD: 0,
    };
  }

  recordUsage(agentId: AgentId, usage: TokenUsage, modelId?: string): void {
    const breakdown = this.state.agentCosts[agentId] ?? createEmptyBreakdown();

    breakdown.inputTokens += usage.input || 0;
    breakdown.outputTokens += usage.output || 0;
    breakdown.reasoningTokens = (breakdown.reasoningTokens ?? 0) + (usage.reasoning || 0);

    const modelInfo = modelId ? getModelInfo(modelId) : undefined;
    const estimate = estimateUsd(usage, modelInfo);
    breakdown.estimatedUSD += estimate.usd;
    breakdown.pricingAvailable = breakdown.pricingAvailable || estimate.pricingAvailable;

    this.state.agentCosts[agentId] = breakdown;
    this.state.totalInputTokens += usage.input || 0;
    this.state.totalOutputTokens += usage.output || 0;
    this.state.totalReasoningTokens += usage.reasoning || 0;
    this.state.totalEstimatedUSD += estimate.usd;
  }

  getState(): CostTracker {
    return {
      totalInputTokens: this.state.totalInputTokens,
      totalOutputTokens: this.state.totalOutputTokens,
      totalReasoningTokens: this.state.totalReasoningTokens,
      agentCosts: { ...this.state.agentCosts },
      totalEstimatedUSD: this.state.totalEstimatedUSD,
    };
  }

  loadState(state: CostTracker): void {
    this.state = {
      totalInputTokens: state.totalInputTokens,
      totalOutputTokens: state.totalOutputTokens,
      totalReasoningTokens: state.totalReasoningTokens,
      agentCosts: { ...state.agentCosts },
      totalEstimatedUSD: state.totalEstimatedUSD,
    };
  }
}
