/**
 * @fileoverview Constants and default configurations for Socratic Council
 */

import type {
  AgentConfig,
  AgentId,
  ModelInfo,
  Provider,
} from "../types/index.js";

// =============================================================================
// MODEL REGISTRY - All available models with metadata
// =============================================================================

export const MODEL_REGISTRY: ModelInfo[] = [
  // OpenAI Models (latest first)
  {
    id: "gpt-5.2-pro",
    provider: "openai",
    name: "GPT-5.2 Pro",
    description: "Most capable reasoning model",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2.50,
      outputCostPer1M: 10.00,
      reasoningCostPer1M: 15.00,
    },
  },
  {
    id: "gpt-5.2",
    provider: "openai",
    name: "GPT-5.2",
    description: "Flagship model for complex tasks",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5.00,
      outputCostPer1M: 15.00,
    },
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    name: "GPT-5 Mini",
    description: "Fast and cost-efficient",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.40,
      outputCostPer1M: 1.60,
    },
  },
  {
    id: "gpt-5-nano",
    provider: "openai",
    name: "GPT-5 Nano",
    description: "Ultra-fast for routing and summaries",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.10,
      outputCostPer1M: 0.40,
    },
  },
  {
    id: "o4-mini",
    provider: "openai",
    name: "o4-mini",
    description: "Optimized reasoning model",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.10,
      outputCostPer1M: 4.40,
      reasoningCostPer1M: 4.40,
    },
  },
  {
    id: "o3",
    provider: "openai",
    name: "o3",
    description: "Advanced reasoning capabilities",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 10.00,
      outputCostPer1M: 40.00,
      reasoningCostPer1M: 40.00,
    },
  },
  {
    id: "o1",
    provider: "openai",
    name: "o1",
    description: "Original reasoning model",
    contextWindow: 128000,
    maxOutputTokens: 32768,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 15.00,
      outputCostPer1M: 60.00,
      reasoningCostPer1M: 60.00,
    },
  },
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    description: "Legacy multimodal model",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2.50,
      outputCostPer1M: 10.00,
    },
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o Mini",
    description: "Legacy fast model",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.15,
      outputCostPer1M: 0.60,
    },
  },
  {
    id: "gpt-4-turbo",
    provider: "openai",
    name: "GPT-4 Turbo",
    description: "Legacy turbo model",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 10.00,
      outputCostPer1M: 30.00,
    },
  },

  // Anthropic Models (latest first) - Using full model IDs for reliability
  // Pricing from https://docs.anthropic.com/en/docs/about-claude/models (Feb 2026)
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    name: "Claude Opus 4.6",
    description: "Latest premium model, adaptive thinking, 128K output",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5.00,
      outputCostPer1M: 25.00,
    },
  },
  {
    id: "claude-opus-4-5-20251101",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Premium model, maximum intelligence",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5.00,
      outputCostPer1M: 25.00,
    },
  },
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and intelligence",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 3.00,
      outputCostPer1M: 15.00,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    name: "Claude Haiku 4.5",
    description: "Fastest with near-frontier intelligence",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.00,
      outputCostPer1M: 5.00,
    },
  },
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    name: "Claude Sonnet 4",
    description: "Balanced Claude 4 model",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 3.00,
      outputCostPer1M: 15.00,
    },
  },
  {
    id: "claude-opus-4-1-20250410",
    provider: "anthropic",
    name: "Claude Opus 4.1",
    description: "High-intelligence Claude 4 model",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5.00,
      outputCostPer1M: 25.00,
    },
  },
  {
    id: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Sonnet",
    description: "Legacy Sonnet",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 3.00,
      outputCostPer1M: 15.00,
    },
  },
  {
    id: "claude-3-5-haiku-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Haiku",
    description: "Legacy Haiku",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.80,
      outputCostPer1M: 4.00,
    },
  },
  {
    id: "claude-3-opus-20240229",
    provider: "anthropic",
    name: "Claude 3 Opus",
    description: "Legacy Opus",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 15.00,
      outputCostPer1M: 75.00,
    },
  },

  // Google Gemini Models (latest first)
  {
    id: "gemini-3-pro-preview",
    provider: "google",
    name: "Gemini 3 Pro",
    description: "Best multimodal and agentic model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.25,
      outputCostPer1M: 5.00,
    },
  },
  {
    id: "gemini-3-pro-image-preview",
    provider: "google",
    name: "Gemini 3 Pro Image",
    description: "Image generation capabilities",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.25,
      outputCostPer1M: 5.00,
    },
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    name: "Gemini 3 Flash",
    description: "Balanced speed and intelligence",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.10,
      outputCostPer1M: 0.40,
    },
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    name: "Gemini 2.5 Pro",
    description: "State-of-the-art thinking model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.25,
      outputCostPer1M: 5.00,
    },
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Best price-performance",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.075,
      outputCostPer1M: 0.30,
    },
  },
  {
    id: "gemini-2.5-flash-lite",
    provider: "google",
    name: "Gemini 2.5 Flash Lite",
    description: "Fastest, cost-efficient",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.02,
      outputCostPer1M: 0.08,
    },
  },
  {
    id: "gemini-2.5-flash-image",
    provider: "google",
    name: "Gemini 2.5 Flash Image",
    description: "Image understanding",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.075,
      outputCostPer1M: 0.30,
    },
  },
  {
    id: "gemini-2.0-flash",
    provider: "google",
    name: "Gemini 2.0 Flash",
    description: "Second-gen workhorse",
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.10,
      outputCostPer1M: 0.40,
    },
  },
  {
    id: "gemini-2.0-flash-lite",
    provider: "google",
    name: "Gemini 2.0 Flash Lite",
    description: "Second-gen small model",
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.02,
      outputCostPer1M: 0.08,
    },
  },

  // DeepSeek Models (latest first)
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    name: "DeepSeek Reasoner",
    description: "V3.2 Thinking Mode, deep reasoning",
    contextWindow: 128000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.55,
      outputCostPer1M: 2.19,
      reasoningCostPer1M: 2.19,
    },
  },
  {
    id: "deepseek-chat",
    provider: "deepseek",
    name: "DeepSeek Chat",
    description: "V3.2 Non-thinking Mode, fast responses",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.27,
      outputCostPer1M: 1.10,
    },
  },

  // Kimi/Moonshot Models (latest first)
  {
    id: "kimi-k2.5",
    provider: "kimi",
    name: "Kimi K2.5",
    description: "Most intelligent, multimodal, SoTA",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.90,
      outputCostPer1M: 3.60,
    },
  },
  {
    id: "kimi-k2-thinking",
    provider: "kimi",
    name: "Kimi K2 Thinking",
    description: "Long-term thinking, multi-step reasoning",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.60,
      outputCostPer1M: 2.40,
    },
  },
  {
    id: "kimi-k2-thinking-turbo",
    provider: "kimi",
    name: "Kimi K2 Thinking Turbo",
    description: "Thinking model, high-speed",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.60,
      outputCostPer1M: 2.40,
    },
  },
  {
    id: "kimi-k2-turbo-preview",
    provider: "kimi",
    name: "Kimi K2 Turbo",
    description: "High-speed K2 (60-100 tok/s)",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.60,
      outputCostPer1M: 2.40,
    },
  },
  {
    id: "kimi-k2-0905-preview",
    provider: "kimi",
    name: "Kimi K2 0905",
    description: "Enhanced Agentic Coding",
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.60,
      outputCostPer1M: 2.40,
    },
  },
  {
    id: "kimi-k2-0711-preview",
    provider: "kimi",
    name: "Kimi K2 0711",
    description: "MoE 1T params, 32B activated",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.55,
      outputCostPer1M: 2.20,
    },
  },
  {
    id: "moonshot-v1-128k",
    provider: "kimi",
    name: "Moonshot V1 128K",
    description: "Long text generation",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.80,
      outputCostPer1M: 0.80,
    },
  },
  {
    id: "moonshot-v1-128k-vision-preview",
    provider: "kimi",
    name: "Moonshot V1 128K Vision",
    description: "Vision model",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.80,
      outputCostPer1M: 0.80,
    },
  },
  {
    id: "moonshot-v1-32k",
    provider: "kimi",
    name: "Moonshot V1 32K",
    description: "Medium text generation",
    contextWindow: 32000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.35,
      outputCostPer1M: 0.35,
    },
  },
  {
    id: "moonshot-v1-32k-vision-preview",
    provider: "kimi",
    name: "Moonshot V1 32K Vision",
    description: "Vision model",
    contextWindow: 32000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.35,
      outputCostPer1M: 0.35,
    },
  },
  {
    id: "moonshot-v1-8k",
    provider: "kimi",
    name: "Moonshot V1 8K",
    description: "Short text generation",
    contextWindow: 8000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.17,
      outputCostPer1M: 0.17,
    },
  },
  {
    id: "moonshot-v1-8k-vision-preview",
    provider: "kimi",
    name: "Moonshot V1 8K Vision",
    description: "Vision model",
    contextWindow: 8000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.17,
      outputCostPer1M: 0.17,
    },
  },
];

// =============================================================================
// API ENDPOINTS
// =============================================================================

export const API_ENDPOINTS: Record<Provider, string> = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  kimi: "https://api.moonshot.cn/v1/chat/completions",
};

// =============================================================================
// DEFAULT AGENT CONFIGURATIONS
// =============================================================================

function baseSystemPrompt(name: string): string {
  return `You are ${name} in the Socratic Council.

CONVERSATION STYLE:
- Keep responses short and direct.
- Do NOT adopt a character or specialty. Speak as yourself.
- Do NOT impersonate other agents.
- Prefer concrete claims and clear reasoning.

HOUSE RULES:
- If you quote a prior message, include @quote(MSG_ID) exactly where you want the quote to appear.
- If you react, use @react(MSG_ID, EMOJI).
- If you call a tool, use @tool(name, {args}) on its own line. Only call a tool when it is strictly necessary.`;
}

export const DEFAULT_AGENTS: Record<AgentId, AgentConfig> = {
  george: {
    id: "george",
    name: "George",
    provider: "openai",
    model: "gpt-5.2",
    systemPrompt: baseSystemPrompt("George"),
    temperature: 0.7,
    maxTokens: 2048,
  },
  cathy: {
    id: "cathy",
    name: "Cathy",
    provider: "anthropic",
    model: "claude-opus-4-6",
    systemPrompt: baseSystemPrompt("Cathy"),
    temperature: 0.8,
    maxTokens: 2048,
  },
  grace: {
    id: "grace",
    name: "Grace",
    provider: "google",
    model: "gemini-3-pro-preview",
    systemPrompt: baseSystemPrompt("Grace"),
    temperature: 0.9,
    maxTokens: 2048,
  },
  douglas: {
    id: "douglas",
    name: "Douglas",
    provider: "deepseek",
    model: "deepseek-reasoner",
    systemPrompt: baseSystemPrompt("Douglas"),
    temperature: 0.6,
    maxTokens: 2048,
  },
  kate: {
    id: "kate",
    name: "Kate",
    provider: "kimi",
    model: "kimi-k2.5",
    systemPrompt: baseSystemPrompt("Kate"),
    temperature: 0.7,
    maxTokens: 2048,
  },
};

// =============================================================================
// BIDDING WEIGHTS
// =============================================================================

export const BIDDING_WEIGHTS = {
  urgency: 0.3,
  relevance: 0.4,
  confidence: 0.2,
  whisperBonus: 0.1,
  randomMax: 5,
} as const;

// =============================================================================
// DEFAULT COUNCIL CONFIG
// =============================================================================

export const DEFAULT_COUNCIL_CONFIG = {
  maxTurns: 50,
  biddingTimeout: 2000,
  budgetLimit: 5.0,
  autoMode: true,
} as const;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getModelsByProvider(provider: Provider): ModelInfo[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_REGISTRY.find((m) => m.id === modelId);
}

export function getDefaultModelForProvider(provider: Provider): string {
  const models = getModelsByProvider(provider);
  return models[0]?.id ?? "";
}

/**
 * Calculate the cost of a single message based on token usage and model pricing
 * Returns cost in USD with pricing availability flag
 */
export function calculateMessageCost(
  modelId: string,
  tokens: { input: number; output: number; reasoning?: number }
): { cost: number; pricingAvailable: boolean } {
  const modelInfo = getModelInfo(modelId);
  const pricing = modelInfo?.pricing;

  if (!pricing || (!pricing.inputCostPer1M && !pricing.outputCostPer1M)) {
    return { cost: 0, pricingAvailable: false };
  }

  const inputCost = ((tokens.input || 0) / 1_000_000) * (pricing.inputCostPer1M ?? 0);
  const outputCost = ((tokens.output || 0) / 1_000_000) * (pricing.outputCostPer1M ?? 0);
  const reasoningCost = ((tokens.reasoning || 0) / 1_000_000) * (pricing.reasoningCostPer1M ?? 0);

  return {
    cost: inputCost + outputCost + reasoningCost,
    pricingAvailable: true,
  };
}
