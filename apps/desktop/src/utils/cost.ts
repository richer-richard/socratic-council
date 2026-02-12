import { MODEL_REGISTRY } from "@socratic-council/shared";

/**
 * Calculate per-message cost based on token usage and model pricing.
 * Returns cost in USD or null if pricing is unavailable.
 */
export function calculateMessageCost(
  modelId: string | undefined,
  tokens: { input: number; output: number; reasoning?: number } | undefined
): number | null {
  if (!modelId || !tokens) return null;

  const modelInfo = MODEL_REGISTRY.find((m) => m.id === modelId);
  const pricing = modelInfo?.pricing;
  if (!pricing || (!pricing.inputCostPer1M && !pricing.outputCostPer1M && !pricing.reasoningCostPer1M)) {
    return null;
  }

  const inputCost = ((tokens.input || 0) / 1_000_000) * (pricing.inputCostPer1M ?? 0);
  const outputCost = ((tokens.output || 0) / 1_000_000) * (pricing.outputCostPer1M ?? 0);
  const reasoningCost = ((tokens.reasoning || 0) / 1_000_000) * (pricing.reasoningCostPer1M ?? 0);

  return inputCost + outputCost + reasoningCost;
}

