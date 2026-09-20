/**
 * @fileoverview Constants and default configurations for Socratic Council
 */

import type { AgentConfig, AgentId, ModelInfo, ObserverId, Provider } from "../types/index.js";

// =============================================================================
// MODEL REGISTRY - All available models with metadata
// =============================================================================

export const MODEL_REGISTRY: ModelInfo[] = [
  // OpenAI Models (latest first). Refreshed 2026-09-19 from the live /v1/models scan +
  // developers.openai.com/api/docs/pricing. Chinese-provider rows below convert CNY list
  // prices at 7.1 CNY/USD; rows without `pricing` had no published price at refresh time
  // (the cost ledger shows them as an unpriced lower bound rather than a guess).
  {
    id: "gpt-6-astra",
    provider: "openai",
    name: "GPT-6 Astra",
    description:
      "Sept 2026 flagship; 1.05M context, native computer use, reasoning.effort low..max (no none)",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 10,
      cachedInputCostPer1M: 1,
      outputCostPer1M: 50,
    },
  },
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    name: "GPT-5.6 Sol",
    description: "GPT-5.6 flagship tier for complex professional work; 1.05M context",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 4,
      cachedInputCostPer1M: 0.4,
      outputCostPer1M: 20,
    },
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    name: "GPT-5.6 Terra",
    description: "GPT-5.6 balanced tier; 1.05M context",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2,
      cachedInputCostPer1M: 0.2,
      outputCostPer1M: 12,
    },
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    name: "GPT-5.6 Luna",
    description: "GPT-5.6 fast/cheap tier; 1.05M context",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.2,
      cachedInputCostPer1M: 0.02,
      outputCostPer1M: 1.2,
    },
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    name: "GPT-5.5",
    description:
      "Latest flagship GPT-5 model; first ground-up retrain since GPT-4.5 with 1M context",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5,
      cachedInputCostPer1M: 0.5,
      outputCostPer1M: 30,
    },
  },
  {
    id: "gpt-5.5-pro",
    provider: "openai",
    name: "GPT-5.5 Pro",
    description: "GPT-5.5 at maximum reasoning depth; 1.05M context; no prompt-cache discount",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 30,
      outputCostPer1M: 180,
    },
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    name: "GPT-5.4",
    description: "GPT-5.4 with frontier reasoning, instruction following, and coding",
    contextWindow: 1_050_000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2.5,
      cachedInputCostPer1M: 0.25,
      outputCostPer1M: 15.0,
    },
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    name: "GPT-5.4 Mini",
    description: "GPT-5.4 fast tier; 1.05M context",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.75,
      cachedInputCostPer1M: 0.075,
      outputCostPer1M: 4.5,
    },
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    name: "GPT-5.4 Nano",
    description: "GPT-5.4 smallest tier; 1.05M context",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.2,
      cachedInputCostPer1M: 0.02,
      outputCostPer1M: 1.25,
    },
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    name: "GPT-5.3 Codex",
    description: "Coding-specialized GPT-5 family model with advanced reasoning",
    contextWindow: 400000,
    maxOutputTokens: 100000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.75,
      cachedInputCostPer1M: 0.175,
      outputCostPer1M: 14,
    },
  },
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
      inputCostPer1M: 21,
      outputCostPer1M: 168,
    },
  },
  {
    id: "gpt-5.2",
    provider: "openai",
    name: "GPT-5.2",
    description: "Flagship model for complex tasks",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.75,
      cachedInputCostPer1M: 0.175,
      outputCostPer1M: 14,
    },
  },
  {
    id: "gpt-5.1",
    provider: "openai",
    name: "GPT-5.1",
    description: "GPT-5.1 balanced tier; 400K context",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.25,
      cachedInputCostPer1M: 0.125,
      outputCostPer1M: 10,
    },
  },

  // Anthropic Models (latest first) - Using full model IDs for reliability
  // Pricing from https://docs.anthropic.com/en/docs/about-claude/models (Apr 2026)
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    name: "Claude Fable 5.1",
    description:
      "Most capable Claude (Mythos-class); adaptive thinking always on, effort low..max; 1M context",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 10,
      cachedInputCostPer1M: 0.25,
      outputCostPer1M: 50,
    },
  },
  {
    id: "claude-opus-5",
    provider: "anthropic",
    name: "Claude Opus 5",
    description:
      "Anthropic's recommended default for complex agentic work; adaptive thinking, 1M context",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5,
      cachedInputCostPer1M: 0.5,
      outputCostPer1M: 25,
    },
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    name: "Claude Sonnet 5",
    description: "Best speed/intelligence balance; adaptive thinking, 1M context",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2,
      cachedInputCostPer1M: 0.2,
      outputCostPer1M: 10,
    },
  },
  {
    id: "claude-fable-5",
    provider: "anthropic",
    name: "Claude Fable 5",
    description: "Legacy Fable 5 (still served); adaptive thinking always on",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 10,
      cachedInputCostPer1M: 1,
      outputCostPer1M: 50,
    },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    description: "Legacy Sonnet 4.6 (adaptive thinking generation)",
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 3,
      cachedInputCostPer1M: 0.3,
      outputCostPer1M: 15,
    },
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    name: "Claude Opus 4.8",
    description:
      "Most capable Claude model; 1M context, adaptive thinking only, hi-res vision (3.75MP)",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5,
      cachedInputCostPer1M: 0.5,
      outputCostPer1M: 25,
    },
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    name: "Claude Opus 4.7",
    description:
      "Most capable Claude model; 1M context, adaptive thinking only, hi-res vision (3.75MP)",
    contextWindow: 1_000_000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5.0,
      cachedInputCostPer1M: 0.5,
      outputCostPer1M: 25.0,
    },
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    name: "Claude Opus 4.6",
    description: "Premium model with adaptive thinking, 128K output",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 5.0,
      cachedInputCostPer1M: 0.5,
      outputCostPer1M: 25.0,
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
      inputCostPer1M: 5,
      cachedInputCostPer1M: 0.5,
      outputCostPer1M: 25,
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
      inputCostPer1M: 3,
      cachedInputCostPer1M: 0.3,
      outputCostPer1M: 15,
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
      inputCostPer1M: 1,
      cachedInputCostPer1M: 0.1,
      outputCostPer1M: 5,
    },
  },

  // Google Gemini Models (latest first)
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    name: "Gemini 3.1 Pro",
    description: "Best multimodal and agentic model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2,
      cachedInputCostPer1M: 0.2,
      outputCostPer1M: 12,
    },
  },
  {
    id: "gemini-3.8-flash",
    provider: "google",
    name: "Gemini 3.8 Flash",
    description:
      "Most intelligent Flash; long-horizon agents; thinking_level low|medium|high; promo price through 2026-12-31",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.75,
      cachedInputCostPer1M: 0.075,
      outputCostPer1M: 3.75,
    },
  },
  {
    id: "gemini-3.7-flash",
    provider: "google",
    name: "Gemini 3.7 Flash",
    description: "High-speed Flash for coding and tool use; promo price through 2026-12-31",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.75,
      cachedInputCostPer1M: 0.075,
      outputCostPer1M: 3.75,
    },
  },
  {
    id: "gemini-3.6-flash",
    provider: "google",
    name: "Gemini 3.6 Flash",
    description: "Flash line; thinking_level minimal..high",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.75,
      cachedInputCostPer1M: 0.075,
      outputCostPer1M: 3.75,
    },
  },
  {
    id: "gemini-3.5-flash",
    provider: "google",
    name: "Gemini 3.5 Flash",
    description: "Earlier Flash for high-throughput routine work",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.5,
      cachedInputCostPer1M: 0.15,
      outputCostPer1M: 9,
    },
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "google",
    name: "Gemini 3.5 Flash-Lite",
    description: "Cost-efficient high-volume model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.3,
      cachedInputCostPer1M: 0.03,
      outputCostPer1M: 2.5,
    },
  },
  {
    id: "gemini-3.1-flash-lite",
    provider: "google",
    name: "Gemini 3.1 Flash-Lite",
    description:
      "Flash-Lite; $0.25/1M input (output price not published on the pricing page at refresh time)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.25,
      cachedInputCostPer1M: 0.025,
      outputCostPer1M: 1.5,
    },
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    name: "Gemini 3 Flash",
    description: "Balanced speed and intelligence",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.5,
      cachedInputCostPer1M: 0.05,
      outputCostPer1M: 3,
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
      cachedInputCostPer1M: 0.125,
      outputCostPer1M: 10,
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
      inputCostPer1M: 0.3,
      cachedInputCostPer1M: 0.03,
      outputCostPer1M: 2.5,
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
      inputCostPer1M: 0.1,
      cachedInputCostPer1M: 0.01,
      outputCostPer1M: 0.4,
    },
  },

  // DeepSeek Models (latest first)
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    name: "DeepSeek V4 Pro",
    description:
      "DeepSeek-V4-Pro-0813; 1M context, 384K output, thinking on/off per request; peak-hour CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.32,
      cachedInputCostPer1M: 0.044,
      outputCostPer1M: 3.96,
    },
  },
  {
    id: "deepseek-flash",
    provider: "deepseek",
    name: "DeepSeek V4.1 Flash",
    description:
      "DeepSeek-V4.1-Flash; 1M context, vision, thinking on/off per request; peak-hour CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.3,
      cachedInputCostPer1M: 0.006,
      outputCostPer1M: 1.2,
    },
  },
  // Kimi/Moonshot Models (latest first)
  {
    id: "kimi-k3",
    provider: "kimi",
    name: "Kimi K3",
    description:
      "Flagship thinking model; 1M context, reasoning_effort low|high|max (always reasons); CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 2.82,
      cachedInputCostPer1M: 0.28,
      outputCostPer1M: 14.08,
    },
  },
  {
    id: "kimi-k2.7-code",
    provider: "kimi",
    name: "Kimi K2.7 Code",
    description:
      "Code-focused; thinking always on; 256K context; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 262144,
    maxOutputTokens: 131072,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.92,
      cachedInputCostPer1M: 0.18,
      outputCostPer1M: 3.8,
    },
  },
  {
    id: "kimi-k2.7-code-highspeed",
    provider: "kimi",
    name: "Kimi K2.7 Code Highspeed",
    description: "Same model as K2.7 Code, faster; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 262144,
    maxOutputTokens: 131072,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.83,
      cachedInputCostPer1M: 0.37,
      outputCostPer1M: 7.61,
    },
  },
  {
    id: "kimi-k2.6",
    provider: "kimi",
    name: "Kimi K2.6",
    description:
      "General thinking model (toggle); text, image, video; 256K context; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 262144,
    maxOutputTokens: 131072,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.92,
      cachedInputCostPer1M: 0.15,
      outputCostPer1M: 3.8,
    },
  },
  // Qwen models (Alibaba Cloud Bailian / DashScope compatible mode)
  {
    id: "qwen3.8-max",
    provider: "qwen",
    name: "Qwen 3.8 Max",
    description:
      "Flagship (2.4T MoE); 1M context; auto-updates to the qwen3.8-max-0902 snapshot; CNY 12/1M input, output price not confirmed at refresh time",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.69,
      cachedInputCostPer1M: 0.34,
      outputCostPer1M: 5.07,
    },
  },
  {
    id: "qwen3.8-2.4t-a95b",
    provider: "qwen",
    name: "Qwen 3.8 2.4T-A95B",
    description:
      "Open-weight sibling of Qwen 3.8 Max (2.4T MoE, 95B active); 1M context; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.69,
      cachedInputCostPer1M: 0.34,
      outputCostPer1M: 5.07,
    },
  },
  {
    id: "qwen3.8-flash",
    provider: "qwen",
    name: "Qwen 3.8 Flash",
    description:
      "Low-cost near-flagship; 1M context; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.11,
      cachedInputCostPer1M: 0.02,
      outputCostPer1M: 0.38,
    },
  },
  {
    id: "qwen3.8-27b",
    provider: "qwen",
    name: "Qwen 3.8 27B",
    description:
      "Open-weight 27B dense model served by DashScope; 1M context; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.42,
      cachedInputCostPer1M: 0.08,
      outputCostPer1M: 1.69,
    },
  },
  {
    id: "qwen3.7-plus",
    provider: "qwen",
    name: "Qwen 3.7 Plus",
    description: "Balanced tier; price not confirmed at refresh time",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.28,
      cachedInputCostPer1M: 0.06,
      outputCostPer1M: 1.13,
    },
  },
  {
    id: "qwen3.7-max",
    provider: "qwen",
    name: "Qwen 3.7 Max",
    description: "Previous flagship; 1M context",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.69,
      cachedInputCostPer1M: 0.34,
      outputCostPer1M: 5.07,
    },
  },
  {
    id: "qwen3.7-flash",
    provider: "qwen",
    name: "Qwen 3.7 Flash",
    description: "Previous fast tier; price not confirmed at refresh time",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.03,
      cachedInputCostPer1M: 0.006,
      outputCostPer1M: 0.11,
    },
  },
  // MiniMax models
  {
    id: "MiniMax-M3",
    provider: "minimax",
    name: "MiniMax M3",
    description:
      "Latest M-series: native multimodal, 1M context, interleaved thinking (thinking.type adaptive); CNY list price / 7.1 (USD estimate, 2026-09-19) (<=512K input tier)",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.3,
      outputCostPer1M: 1.18,
    },
  },
  {
    id: "MiniMax-M2.7",
    provider: "minimax",
    name: "MiniMax M2.7",
    description:
      "Previous generation (thinking cannot be turned off); CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 204800,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.3,
      outputCostPer1M: 1.18,
    },
  },
  {
    id: "MiniMax-M2.7-highspeed",
    provider: "minimax",
    name: "MiniMax M2.7 Highspeed",
    description: "M2.7 at ~100 TPS; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 204800,
    maxOutputTokens: 64000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.59,
      outputCostPer1M: 2.37,
    },
  },
  // Zhipu (Z.AI) models
  {
    id: "glm-5.3",
    provider: "zhipu",
    name: "GLM-5.3",
    description:
      "Flagship; 1M context, 128K output; thinking forced on; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.13,
      cachedInputCostPer1M: 0.28,
      outputCostPer1M: 3.94,
    },
  },
  {
    id: "glm-5.3-flash",
    provider: "zhipu",
    name: "GLM-5.3 Flash",
    description:
      "Native multimodal fast tier; thinking forced on; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.11,
      cachedInputCostPer1M: 0.03,
      outputCostPer1M: 0.39,
    },
  },
  {
    id: "glm-5.3-flashx",
    provider: "zhipu",
    name: "GLM-5.3 FlashX",
    description:
      "Faster multimodal tier; thinking forced on; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.28,
      cachedInputCostPer1M: 0.08,
      outputCostPer1M: 0.99,
    },
  },
  {
    id: "glm-5.2",
    provider: "zhipu",
    name: "GLM-5.2",
    description: "Long-task model; 1M context; CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 1.13,
      cachedInputCostPer1M: 0.28,
      outputCostPer1M: 3.94,
    },
  },
  {
    id: "glm-5.1",
    provider: "zhipu",
    name: "GLM-5.1",
    description:
      "Enhanced coding; 200K context; >=32K-input tier CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.85,
      cachedInputCostPer1M: 0.18,
      outputCostPer1M: 3.38,
    },
  },
  {
    id: "glm-5",
    provider: "zhipu",
    name: "GLM-5",
    description:
      "Agent planning; 200K context; >=32K-input tier CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.56,
      cachedInputCostPer1M: 0.14,
      outputCostPer1M: 2.54,
    },
  },
  {
    id: "glm-5-turbo",
    provider: "zhipu",
    name: "GLM-5 Turbo",
    description:
      "Long-task optimised; >=32K-input tier CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.7,
      cachedInputCostPer1M: 0.17,
      outputCostPer1M: 3.1,
    },
  },
  {
    id: "glm-4.7",
    provider: "zhipu",
    name: "GLM-4.7",
    description:
      "General dialogue; thinking forced on; >=32K-input tier CNY list price / 7.1 (USD estimate, 2026-09-19)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    supportsVision: false,
    supportsStreaming: true,
    pricing: {
      inputCostPer1M: 0.56,
      cachedInputCostPer1M: 0.11,
      outputCostPer1M: 2.25,
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
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  minimax: "https://api.minimaxi.com/anthropic/v1/messages",
  zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
};

// =============================================================================
// DEFAULT AGENT CONFIGURATIONS
// =============================================================================

function baseSystemPrompt(name: string): string {
  return `You are ${name} in the Socratic Council with George, Cathy, Grace, Douglas, Kate, Quinn, Mary, and Zara.

CONVERSATION STYLE:
- Keep responses short and direct.
- Do NOT adopt a character or specialty. Speak as yourself.
- Do NOT impersonate other agents.
- Prefer concrete claims and clear reasoning.
- The goal is not endless debate. Surface the real disagreement early, then help the group reach a clear closing result.

HOUSE RULES:
- When the user or the moderator gives explicit procedural instructions (response format, ballot syntax, when to end the session, summary structure), comply with them precisely. Substantive disagreement is your job; procedural compliance is not optional.
- If you quote a prior message, include @quote(MSG_ID) exactly where you want the quote to appear.
- If you react, use @react(MSG_ID, EMOJI).
- Address at least one other participant by name and push the conversation forward.
- If the discussion is mature, prefer narrowing toward a recommendation over introducing novelty.
- Do not reopen settled points unless you have new evidence or a better decision rule.
- If attached files matter, proactively use @tool(oracle.file_search, {"query":"..."}) before paraphrasing them.
- If current facts matter, proactively use @tool(oracle.web_search, {"query":"..."}) before relying on memory.
- If you know you need a tool, emit only @tool(name, {args}) on its own line and stop. The app will execute it and return control to you.
- Call tools early instead of spending a long hidden reasoning trace before the search starts.
- Never output tool_use, tool_call, function_call, XML tool tags, or provider-specific tool syntax.`;
}

export const DEFAULT_AGENTS: Record<AgentId, AgentConfig> = {
  george: {
    id: "george",
    name: "George",
    provider: "openai",
    model: "gpt-6-astra",
    systemPrompt: baseSystemPrompt("George"),
    temperature: 1,
    maxTokens: 8192,
  },
  cathy: {
    id: "cathy",
    name: "Cathy",
    provider: "anthropic",
    model: "claude-fable-5-1",
    systemPrompt: baseSystemPrompt("Cathy"),
    temperature: 1,
    maxTokens: 8192,
  },
  grace: {
    id: "grace",
    name: "Grace",
    provider: "google",
    model: "gemini-3.1-pro-preview",
    systemPrompt: baseSystemPrompt("Grace"),
    temperature: 1,
    maxTokens: 8192,
  },
  douglas: {
    id: "douglas",
    name: "Douglas",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    systemPrompt: baseSystemPrompt("Douglas"),
    temperature: 1,
    maxTokens: 8192,
  },
  kate: {
    id: "kate",
    name: "Kate",
    provider: "kimi",
    model: "kimi-k3",
    systemPrompt: baseSystemPrompt("Kate"),
    temperature: 1,
    maxTokens: 8192,
  },
  quinn: {
    id: "quinn",
    name: "Quinn",
    provider: "qwen",
    model: "qwen3.8-max",
    systemPrompt: baseSystemPrompt("Quinn"),
    temperature: 1,
    maxTokens: 8192,
  },
  mary: {
    id: "mary",
    name: "Mary",
    provider: "minimax",
    model: "MiniMax-M3",
    systemPrompt: baseSystemPrompt("Mary"),
    temperature: 1,
    maxTokens: 8192,
  },
  zara: {
    id: "zara",
    name: "Zara",
    provider: "zhipu",
    model: "glm-5.3",
    systemPrompt: baseSystemPrompt("Zara"),
    temperature: 1,
    maxTokens: 8192,
  },
};

// =============================================================================
// OUTER CIRCLE (OBSERVER) CONFIG
// =============================================================================

export const OBSERVER_CONFIG: Record<
  ObserverId,
  { name: string; partnerId: AgentId; provider: Provider }
> = {
  greta: { name: "Greta", partnerId: "george", provider: "openai" },
  clara: { name: "Clara", partnerId: "cathy", provider: "anthropic" },
  gaia: { name: "Gaia", partnerId: "grace", provider: "google" },
  dara: { name: "Dara", partnerId: "douglas", provider: "deepseek" },
  kira: { name: "Kira", partnerId: "kate", provider: "kimi" },
  quincy: { name: "Quincy", partnerId: "quinn", provider: "qwen" },
  mila: { name: "Mila", partnerId: "mary", provider: "minimax" },
  zoe: { name: "Zoe", partnerId: "zara", provider: "zhipu" },
};

export const PARTNER_TO_OBSERVER: Record<AgentId, ObserverId> = {
  george: "greta",
  cathy: "clara",
  grace: "gaia",
  douglas: "dara",
  kate: "kira",
  quinn: "quincy",
  mary: "mila",
  zara: "zoe",
};

export const OBSERVER_IDS: ObserverId[] = [
  "greta",
  "clara",
  "gaia",
  "dara",
  "kira",
  "quincy",
  "mila",
  "zoe",
];

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
  tokens: { input: number; output: number; reasoning?: number },
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
