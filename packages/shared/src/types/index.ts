/**
 * @fileoverview Core type definitions for Socratic Council
 * Each provider has specific model parameters - these are carefully defined
 */

import { z } from "zod";

// =============================================================================
// PROVIDER TYPES
// =============================================================================

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "minimax"
  | "zhipu";

// =============================================================================
// OPENAI MODELS & PARAMETERS
// =============================================================================

export const OpenAIModels = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
  "gpt-5.2-pro",
  "gpt-5.2",
  "gpt-5-mini",
  "gpt-5-nano",
  "o4-mini",
  "o3",
  "o1",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
] as const;

export type OpenAIModel = (typeof OpenAIModels)[number];

export const OpenAIConfigSchema = z.object({
  model: z.enum(OpenAIModels),
  temperature: z.number().min(0).max(2).optional().default(1),
  max_tokens: z.number().min(1).max(128000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  // For reasoning models (o1, o3, o4-mini)
  reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  // New Responses API format
  reasoning: z
    .object({
      effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
    })
    .optional(),
  stream: z.boolean().optional().default(true),
});

export type OpenAIConfig = z.infer<typeof OpenAIConfigSchema>;

// OpenAI Responses API request format
export interface OpenAIRequest {
  model: OpenAIModel;
  input: string | Array<{ role: "user" | "assistant" | "system"; content: string }>;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  // Preferred Responses API format
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    summary?: "auto" | "concise" | "detailed";
  };
  // Deprecated (kept for compatibility)
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  stream?: boolean;
}

// =============================================================================
// ANTHROPIC MODELS & PARAMETERS
// =============================================================================

export const AnthropicModels = [
  // Claude 4.8 model (latest flagship)
  "claude-opus-4-8",
  // Claude 4.7 model
  "claude-opus-4-7",
  // Claude 4.6 model
  "claude-opus-4-6",
  // Claude 4.5 models with full dated IDs (recommended for production)
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  // Claude 4 models
  "claude-sonnet-4-20250514",
  "claude-opus-4-1-20250410",
  // Legacy Claude 3.5 models
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
] as const;

export type AnthropicModel = (typeof AnthropicModels)[number];

export const AnthropicConfigSchema = z.object({
  model: z.enum(AnthropicModels),
  max_tokens: z.number().min(1).max(128000).default(4096),
  temperature: z.number().min(0).max(1).optional().default(1),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().min(0).optional(),
  // Extended thinking - boolean for legacy, or "adaptive" for Claude 4.6+
  thinking: z.union([z.boolean(), z.literal("adaptive")]).optional(),
  stream: z.boolean().optional().default(true),
});

export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>;

// Anthropic Messages API request format
export interface AnthropicRequest {
  model: AnthropicModel;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: "text"; text: string }>;
  }>;
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  metadata?: {
    user_id?: string;
  };
}

// =============================================================================
// GOOGLE GEMINI MODELS & PARAMETERS
// =============================================================================

export const GeminiModels = [
  "gemini-3.1-pro-preview",
  // Legacy alias retained for migration/back-compat
  "gemini-3-pro-preview",
  "gemini-3-pro-image-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-image",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
] as const;

export type GeminiModel = (typeof GeminiModels)[number];

export const GeminiConfigSchema = z.object({
  model: z.enum(GeminiModels),
  temperature: z.number().min(0).max(2).optional().default(1),
  max_output_tokens: z.number().min(1).max(65536).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().min(1).max(100).optional(),
  // Thinking mode for gemini-2.5-pro
  thinking_config: z
    .object({
      thinking_budget: z.number().min(0).max(24576).optional(),
    })
    .optional(),
  stream: z.boolean().optional().default(true),
});

export type GeminiConfig = z.infer<typeof GeminiConfigSchema>;

// Google Gemini API request format
export interface GeminiRequest {
  contents: Array<{
    role: "user" | "model";
    parts: Array<
      | { text: string }
      | {
          inlineData: {
            mimeType: string;
            data: string;
          };
        }
    >;
  }>;
  systemInstruction?: {
    parts: Array<
      | { text: string }
      | {
          inlineData: {
            mimeType: string;
            data: string;
          };
        }
    >;
  };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    thinkingConfig?: {
      thinkingBudget?: number;
      includeThoughts?: boolean;
    };
  };
}

// =============================================================================
// DEEPSEEK MODELS & PARAMETERS
// =============================================================================

export const DeepSeekModels = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-reasoner",
  "deepseek-chat",
] as const;

export type DeepSeekModel = (typeof DeepSeekModels)[number];

export const DeepSeekConfigSchema = z.object({
  model: z.enum(DeepSeekModels),
  temperature: z.number().min(0).max(2).optional().default(1),
  max_tokens: z.number().min(1).max(64000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stream: z.boolean().optional().default(true),
});

export type DeepSeekConfig = z.infer<typeof DeepSeekConfigSchema>;

// DeepSeek uses OpenAI-compatible API format
export interface DeepSeekRequest {
  // Accepts catalog or live-scanned ids (see AnyModelId).
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
}

// =============================================================================
// KIMI (MOONSHOT) MODELS & PARAMETERS
// =============================================================================

export const KimiModels = [
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "kimi-k2-turbo-preview",
  "kimi-k2-0905-preview",
  "kimi-k2-0711-preview",
  "moonshot-v1-128k",
  "moonshot-v1-128k-vision-preview",
  "moonshot-v1-32k",
  "moonshot-v1-32k-vision-preview",
  "moonshot-v1-8k",
  "moonshot-v1-8k-vision-preview",
] as const;

export type KimiModel = (typeof KimiModels)[number];

export const KimiConfigSchema = z.object({
  model: z.enum(KimiModels),
  temperature: z.number().min(0).max(1).optional().default(0.7),
  max_tokens: z.number().min(1).max(128000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  // Kimi-specific: enable search for fact-checking
  use_search: z.boolean().optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  stream: z.boolean().optional().default(true),
});

export type KimiConfig = z.infer<typeof KimiConfigSchema>;

// Kimi uses OpenAI-compatible API format
export interface KimiRequest {
  // Accepts catalog or live-scanned ids (see AnyModelId).
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content:
      | string
      | Array<
          | {
              type: "text";
              text: string;
            }
          | {
              type: "image_url";
              image_url: {
                url: string;
              };
            }
        >;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  use_search?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  stream?: boolean;
}

// =============================================================================
// QWEN MODELS & PARAMETERS
// =============================================================================

export const QwenModels = [
  "qwen3.7-max",
  "qwen3.6-max-preview",
  "qwen3.6-plus",
  "qwen3.5-plus",
] as const;

export type QwenModel = (typeof QwenModels)[number];

export const QwenConfigSchema = z.object({
  model: z.enum(QwenModels),
  temperature: z.number().min(0).max(2).optional().default(1),
  max_tokens: z.number().min(1).max(128000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional().default(true),
});

export type QwenConfig = z.infer<typeof QwenConfigSchema>;

export interface QwenRequest {
  // Accepts catalog or live-scanned ids (see AnyModelId).
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  enable_thinking?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream_options?: {
    include_usage?: boolean;
  };
  stream?: boolean;
}

// =============================================================================
// MINIMAX MODELS & PARAMETERS
// =============================================================================

export const MiniMaxModels = [
  "MiniMax-M2.7-highspeed",
  // Lowercase alias retained for migration/back-compat.
  "minimax-m2.7-highspeed",
] as const;

export type MiniMaxModel = (typeof MiniMaxModels)[number];

export const MiniMaxConfigSchema = z.object({
  model: z.enum(MiniMaxModels),
  temperature: z.number().min(0).max(1).optional().default(1),
  max_tokens: z.number().min(1).max(128000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional().default(true),
});

export type MiniMaxConfig = z.infer<typeof MiniMaxConfigSchema>;

export interface MiniMaxRequest {
  // Accepts catalog or live-scanned ids (see AnyModelId).
  model: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: "text"; text: string }>;
  }>;
  system?: string;
  thinking?: {
    type: "enabled";
    budget_tokens?: number;
  };
  reasoning_split?: boolean;
  metadata?: {
    user_id?: string;
  };
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
}

// =============================================================================
// ZHIPU (Z.AI) MODELS & PARAMETERS
// =============================================================================

export const ZhipuModels = ["glm-5.1", "glm-5", "glm-4.7"] as const;

export type ZhipuModel = (typeof ZhipuModels)[number];

export const ZhipuConfigSchema = z.object({
  model: z.enum(ZhipuModels),
  temperature: z.number().min(0).max(1).optional().default(0.7),
  max_tokens: z.number().min(1).max(128000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional().default(true),
});

export type ZhipuConfig = z.infer<typeof ZhipuConfigSchema>;

export interface ZhipuRequest {
  // Accepts catalog or live-scanned ids (see AnyModelId).
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
}

// =============================================================================
// UNIFIED MODEL TYPE
// =============================================================================

export type ModelId =
  | OpenAIModel
  | AnthropicModel
  | GeminiModel
  | DeepSeekModel
  | KimiModel
  | QwenModel
  | MiniMaxModel
  | ZhipuModel;

export const ModelIdSchema = z.union([
  z.enum(OpenAIModels),
  z.enum(AnthropicModels),
  z.enum(GeminiModels),
  z.enum(DeepSeekModels),
  z.enum(KimiModels),
  z.enum(QwenModels),
  z.enum(MiniMaxModels),
  z.enum(ZhipuModels),
]);

export interface ModelInfo {
  id: ModelId;
  provider: Provider;
  name: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  pricing?: {
    inputCostPer1M?: number;
    outputCostPer1M?: number;
    reasoningCostPer1M?: number;
  };
}

/**
 * A model id chosen at runtime. It is usually one of the catalog `ModelId`s,
 * but with live capability-scanning the user can also select an id the
 * provider reports that we have never seen before — so the accepted type is
 * widened to any string while keeping `ModelId` autocompletion for the
 * known catalog. (The `& {}` keeps the literal union suggestions alive.)
 */
export type AnyModelId = ModelId | (string & {});

/**
 * Council-wide reasoning levels. Each level maps to (a) a chosen model per
 * provider (see `modelSelection` in the desktop config) and (b) a
 * provider-specific reasoning-effort knob (see the SDK `reasoningTier`
 * option). `"high"` is the debate default; `"low"` drives fast background
 * tasks (bidding, summaries, arg-map extraction, fact-checks).
 */
export type ReasoningTier = "low" | "medium" | "high";

export const REASONING_TIERS: ReasoningTier[] = ["low", "medium", "high"];

export const REASONING_TIER_LABELS: Record<ReasoningTier, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Sentinel meaning "let the resolver pick the best model for this tier". */
export const AUTO_MODEL = "auto" as const;

/**
 * A model discovered by scanning a provider's list-models endpoint, or
 * synthesized from the static catalog as a fallback. Enriched with catalog
 * metadata when the id is recognized.
 */
export interface DiscoveredModel {
  id: string;
  provider: Provider;
  displayName?: string;
  /** Unix seconds, when the provider reports a creation time. */
  created?: number;
  source: "scanned" | "catalog";
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  pricing?: ModelInfo["pricing"];
}

// =============================================================================
// AGENT TYPES
// =============================================================================

export type AgentId = "george" | "cathy" | "grace" | "douglas" | "kate" | "quinn" | "mary" | "zara";

export type ObserverId = "greta" | "clara" | "gaia" | "dara" | "kira" | "quincy" | "mila" | "zoe";

export interface AgentConfig {
  id: AgentId;
  name: string;
  provider: Provider;
  /** Catalog id or a live-scanned id (see {@link AnyModelId}). */
  model: AnyModelId;
  systemPrompt: string;
  avatar?: string;
  temperature?: number;
  maxTokens?: number;
  /** Reasoning level this agent debates at; defaults to `"high"`. */
  reasoningTier?: ReasoningTier;
}

export const AgentConfigSchema = z.object({
  id: z.enum(["george", "cathy", "grace", "douglas", "kate", "quinn", "mary", "zara"]),
  name: z.string().min(1).max(50),
  provider: z.enum([
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "kimi",
    "qwen",
    "minimax",
    "zhipu",
  ]),
  // Accept any non-empty string: live-scanned ids are not in the catalog
  // enums. `ModelIdSchema` is retained above for places that still want to
  // validate against the known catalog.
  model: z.string().min(1),
  systemPrompt: z.string(),
  avatar: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).optional(),
  reasoningTier: z.enum(["low", "medium", "high"]).optional(),
});

// =============================================================================
// MESSAGE TYPES
// =============================================================================

export interface Message {
  id: string;
  agentId: AgentId | "user" | "system" | "tool";
  content: string;
  timestamp: number;
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
  };
  metadata?: {
    model: AnyModelId;
    latencyMs: number;
    bidScore?: number;
  };
}

// =============================================================================
// PROVIDER CREDENTIALS
// =============================================================================

export interface ProviderCredentials {
  openai?: { apiKey: string; baseUrl?: string };
  anthropic?: { apiKey: string; baseUrl?: string };
  google?: { apiKey: string; baseUrl?: string };
  deepseek?: { apiKey: string; baseUrl?: string };
  kimi?: { apiKey: string; baseUrl?: string };
  qwen?: { apiKey: string; baseUrl?: string };
  minimax?: { apiKey: string; baseUrl?: string };
  zhipu?: { apiKey: string; baseUrl?: string };
}

export const ProviderCredentialsSchema = z.object({
  openai: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  anthropic: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  google: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  deepseek: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  kimi: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  qwen: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  minimax: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
  zhipu: z.object({ apiKey: z.string().min(1), baseUrl: z.string().optional() }).optional(),
});

// =============================================================================
// WHISPER PROTOCOL
// =============================================================================

export type WhisperType = "alliance_request" | "alliance_accept" | "alliance_reject" | "strategy";

export interface WhisperMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  type: WhisperType;
  payload: {
    targetTopic?: string;
    proposedAction?: string;
    bidBonus?: number;
  };
  timestamp: number;
}

export interface WhisperState {
  messages: WhisperMessage[];
  pendingBonuses: Record<AgentId, number>;
}

// =============================================================================
// CONFLICT DETECTION
// =============================================================================

export interface ConflictDetection {
  agentPair: [AgentId, AgentId];
  conflictScore: number;
  threshold: number;
  lastUpdated: number;
}

export interface PairwiseConflict {
  agents: [AgentId, AgentId];
  score: number; // 0-1 normalized
}

// =============================================================================
// COST TRACKING
// =============================================================================

export interface AgentCostBreakdown {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  estimatedUSD: number;
  pricingAvailable?: boolean;
}

export interface CostTracker {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  agentCosts: Record<AgentId, AgentCostBreakdown>;
  totalEstimatedUSD: number;
}

// =============================================================================
// ORACLE TOOL
// =============================================================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface OracleResult {
  query: string;
  results: SearchResult[];
}

export interface VerificationResult {
  claim: string;
  verdict: "true" | "false" | "uncertain";
  confidence: number;
  evidence?: SearchResult[];
}

export interface Citation {
  title: string;
  url: string;
  snippet: string;
}

export interface OracleTool {
  search(query: string): Promise<SearchResult[]>;
  verify(claim: string): Promise<VerificationResult>;
  cite(topic: string): Promise<Citation[]>;
}

// =============================================================================
// AGENT CONTEXT
// =============================================================================

export interface AgentResponse {
  agentId: AgentId;
  content: string;
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
  };
  metadata?: {
    model?: AnyModelId;
    latencyMs?: number;
  };
}
