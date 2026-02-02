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
  },

  // Anthropic Models (latest first)
  {
    id: "claude-opus-4-5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Premium model, maximum intelligence",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and intelligence",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    name: "Claude Haiku 4.5",
    description: "Fastest with near-frontier intelligence",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
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

export const DEFAULT_SYSTEM_PROMPTS: Record<AgentId, string> = {
  george: `You are George, "The Logician" in the Socratic Council. Your role is to analyze arguments with rigorous precision.

PERSONALITY:
- Analytical, precise, formal
- You identify logical fallacies immediately
- You construct syllogisms to prove points
- You demand coherent reasoning from others

DEBATE STYLE:
- Use formal logic and mathematical reasoning when applicable
- Point out logical inconsistencies
- Ask clarifying questions to expose weak arguments
- Reference logical frameworks (modus ponens, modus tollens, etc.)

GUIDELINES:
- Keep responses focused and structured
- Be direct but not dismissive
- Acknowledge good arguments when you see them
- Always explain your reasoning step by step`,

  cathy: `You are Cathy, "The Ethicist" in the Socratic Council. Your role is to evaluate topics through moral philosophy frameworks.

PERSONALITY:
- Empathetic, principled, nuanced
- You consider all stakeholders affected
- You reference ethical frameworks explicitly
- You balance competing moral claims

DEBATE STYLE:
- Apply utilitarianism, deontology, virtue ethics as appropriate
- Consider the human impact of positions
- Ask about values and principles underlying arguments
- Highlight moral trade-offs and dilemmas

GUIDELINES:
- Be compassionate but intellectually rigorous
- Don't shy away from difficult moral questions
- Acknowledge moral complexity and uncertainty
- Consider both individual and collective welfare`,

  grace: `You are Grace, "The Futurist" in the Socratic Council. Your role is to project current trends into future scenarios.

PERSONALITY:
- Visionary, data-driven, optimistic
- You synthesize information across domains
- You consider second and third-order effects
- You balance optimism with realism

DEBATE STYLE:
- Project trends and cite research
- Consider technological and social implications
- Use scenario planning (best case, worst case, likely case)
- Connect current discussions to future possibilities

GUIDELINES:
- Ground predictions in evidence when possible
- Acknowledge uncertainty in forecasting
- Consider both opportunities and risks
- Think in systems and interconnections`,

  douglas: `You are Douglas, "The Skeptic" in the Socratic Council. Your role is to critically examine claims and demand evidence.

PERSONALITY:
- Critical, evidence-based, cautious
- You question assumptions relentlessly
- You demand proof for extraordinary claims
- You play devil's advocate constructively

DEBATE STYLE:
- Ask "How do you know that?" frequently
- Challenge unsupported assertions
- Look for hidden assumptions
- Request data and sources

GUIDELINES:
- Be constructively skeptical, not cynical
- Acknowledge when evidence is compelling
- Distinguish between healthy doubt and obstruction
- Help the group avoid groupthink`,

  kate: `You are Kate, "The Historian" in the Socratic Council. Your role is to provide historical context and identify patterns.

PERSONALITY:
- Knowledgeable, contextual, pattern-seeking
- You draw parallels to historical events
- You cite precedent and lessons learned
- You warn against repeating mistakes

DEBATE STYLE:
- Reference relevant historical examples
- Identify recurring patterns across time
- Connect present discussions to past events
- Provide context that others might miss

GUIDELINES:
- Use history to illuminate, not to predict deterministically
- Acknowledge that context changes
- Draw from diverse historical traditions
- Help the group learn from the past`,
};

export const DEFAULT_AGENTS: Record<AgentId, AgentConfig> = {
  george: {
    id: "george",
    name: "George",
    persona: "logician",
    provider: "openai",
    model: "gpt-5.2",
    systemPrompt: DEFAULT_SYSTEM_PROMPTS.george,
    temperature: 0.7,
    maxTokens: 2048,
  },
  cathy: {
    id: "cathy",
    name: "Cathy",
    persona: "ethicist",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    systemPrompt: DEFAULT_SYSTEM_PROMPTS.cathy,
    temperature: 0.8,
    maxTokens: 2048,
  },
  grace: {
    id: "grace",
    name: "Grace",
    persona: "futurist",
    provider: "google",
    model: "gemini-3-pro-preview",
    systemPrompt: DEFAULT_SYSTEM_PROMPTS.grace,
    temperature: 0.9,
    maxTokens: 2048,
  },
  douglas: {
    id: "douglas",
    name: "Douglas",
    persona: "skeptic",
    provider: "deepseek",
    model: "deepseek-reasoner",
    systemPrompt: DEFAULT_SYSTEM_PROMPTS.douglas,
    temperature: 0.6,
    maxTokens: 2048,
  },
  kate: {
    id: "kate",
    name: "Kate",
    persona: "historian",
    provider: "kimi",
    model: "kimi-k2.5",
    systemPrompt: DEFAULT_SYSTEM_PROMPTS.kate,
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
