/**
 * Types mirroring the Rust engine (`engine/src/deliberation`, `types`,
 * `tools`): what the Tauri backend accepts in `engine_start`, what it emits
 * on `engine://event`, and the catalog rows it serves. Field names follow the
 * Rust serde output: snake_case inside engine-owned structs, camelCase on the
 * request envelope the backend defines.
 */

export type EngineProvider =
  "openai" | "anthropic" | "google" | "deepseek" | "kimi" | "qwen" | "minimax" | "zhipu";

export type EngineReasoningTier = "low" | "medium" | "high";

/** "auto" (flagship), "auto-balanced", "auto-fast", or a model id. */
export type EngineModelChoice = string;

export interface EngineSeat {
  id: string;
  name: string;
  provider: EngineProvider;
  model: EngineModelChoice;
  reasoning?: EngineReasoningTier;
}

export interface EngineSlot {
  provider: EngineProvider;
  model: EngineModelChoice;
}

export type EngineApproval = "auto" | "ask";

export interface EngineShellPolicy {
  enabled: boolean;
  unsandboxed: boolean;
  timeout_secs: number;
  max_output_bytes: number;
}

export interface EngineToolPolicy {
  attachments: boolean;
  web: boolean;
  verify: boolean;
  workspace_files: boolean;
  shell: EngineShellPolicy;
  max_calls_per_turn: number;
  max_iterations: number;
  approval: EngineApproval;
}

export interface EngineRoundTiers {
  positions: EngineReasoningTier;
  cross: EngineReasoningTier;
  revision: EngineReasoningTier;
  subtask: EngineReasoningTier;
  utility: EngineReasoningTier;
  record: EngineReasoningTier;
}

export interface EngineProtocolPolicy {
  max_rounds: number;
  max_principals: number;
  interactive: boolean;
  tiers: EngineRoundTiers;
  concurrency: number;
}

export type EngineDeliverable = "decision" | "analysis" | "document" | "review";
export type EngineSeatRole = "principal" | "support";

export interface EnginePlan {
  deliverable: EngineDeliverable;
  question: string;
  options: string[];
  settles: string;
  participants: { seat: string; role: EngineSeatRole; reason: string }[];
  lenses: Record<string, string>;
  subtasks: { seat: string; task: string; tools: string[]; word_cap: number }[];
  rounds: number;
  ask_user: string | null;
}

export interface EngineEstimate {
  calls: number;
  usd_low: number;
  usd_high: number;
  unpriced_seats: string[];
}

export interface EngineEvidence {
  claim: string;
  source: string;
  by: string;
}

export interface EngineBoard {
  settled: string[];
  disagreements: { between: string[]; about: string }[];
  evidence: EngineEvidence[];
  open_questions: string[];
  positions: Record<string, string>;
}

export interface EngineConvergence {
  moved: string[];
  open_disagreements: number;
  recommend: "revise" | "another_round" | "close";
  why: string;
}

export interface EngineUsage {
  input: number;
  output: number;
  reasoning: number;
  cached_input: number;
  cache_write: number;
}

export interface EngineCostRow {
  agent_id: string;
  name: string;
  lane: string;
  input: number;
  output: number;
  reasoning: number;
  usd: number;
  priced: boolean;
}

export interface EngineCostSnapshot {
  rows: EngineCostRow[];
  lane_usd: [string, number][];
  total_usd: number;
  total_input: number;
  total_output: number;
  total_reasoning: number;
  all_priced: boolean;
  daily_usd: number;
  session_cap: number;
  daily_cap: number;
  note: string | null;
}

export interface EngineDecisionRecord {
  deliverable: EngineDeliverable;
  question: string;
  answer: string;
  confidence: number;
  options_considered: { option: string; why_not: string }[];
  dissent: { seat: string; position: string; why_not_carried: string }[];
  assumptions: string[];
  evidence: EngineEvidence[];
  open_questions: string[];
  next_actions: string[];
  what_changed: string;
  votes: Record<string, string>;
  cost: EngineCostSnapshot | null;
}

export type EngineRoundKind = "prep" | "positions" | { cross: number } | "revision" | "critique";

export interface EngineToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  signature?: string;
}

export type EngineEvent =
  | { event: "phase"; name: string }
  | { event: "plan"; plan: EnginePlan; corrections: string[] }
  | { event: "estimate"; estimate: EngineEstimate }
  | { event: "user_question"; id: string; question: string }
  | {
      event: "seat_started";
      seat_id: string;
      name: string;
      provider: EngineProvider;
      model: string;
      round: EngineRoundKind;
    }
  | { event: "token"; seat_id: string; text: string }
  | { event: "thinking"; seat_id: string; text: string }
  | { event: "tool_approval"; id: string; seat_id: string; call: EngineToolCall }
  | {
      event: "tool_call";
      seat_id: string;
      call: EngineToolCall;
      output: string;
      error: string | null;
    }
  | {
      event: "seat_finished";
      seat_id: string;
      name: string;
      round: EngineRoundKind;
      usage: EngineUsage;
      content: string;
      structured: Record<string, unknown>;
    }
  | { event: "board"; board: EngineBoard }
  | { event: "convergence"; convergence: EngineConvergence }
  | { event: "moderator"; text: string }
  | { event: "record"; record: EngineDecisionRecord }
  | { event: "document"; markdown: string }
  | { event: "cost"; snapshot: EngineCostSnapshot }
  | { event: "error"; message: string }
  | { event: "done"; session_id: string };

/** One tool use a seat made during a turn, as persisted in the session file. */
export interface EngineToolUse {
  call: EngineToolCall;
  output: string;
  error: string | null;
}

/** One seat's turn in a round, as persisted in the session file. */
export interface EngineRoundEntry {
  seat: string;
  name: string;
  model: string;
  content: string;
  structured: unknown;
  tool_uses: EngineToolUse[];
  usage: EngineUsage;
}

export interface EngineRoundLog {
  kind: EngineRoundKind;
  entries: EngineRoundEntry[];
}

/**
 * The deliberation's own data in a v2 session file (the engine writes these
 * as top-level keys next to the flat `messages`; the app keeps them under
 * `session.engine`).
 */
export interface EngineSessionData {
  plan: EnginePlan | null;
  corrections: string[];
  estimate: EngineEstimate | null;
  board: EngineBoard | null;
  rounds: EngineRoundLog[];
  convergences: EngineConvergence[];
  record: EngineDecisionRecord | null;
  document: string | null;
  costs: EngineCostSnapshot | null;
  stoppedEarly: string | null;
  /** The roster the run was started with (for names and provider colours). */
  seats: EngineSeat[];
}

export type EngineInput =
  | { input: "tool_decision"; id: string; allow: boolean }
  | { input: "user_answer"; id: string; text: string }
  | { input: "cancel" };

export interface EngineEnvelope {
  session_id: string;
  event: EngineEvent;
}

/** A catalog row as `engine_catalog` / `engine_scan` return it. */
export interface EngineCatalogRow {
  id: string;
  provider: EngineProvider;
  name: string;
  class: "flagship" | "balanced" | "fast";
  contextWindow: number;
  maxOutput: number;
  inputCostPer1m: number | null;
  cachedInputCostPer1m: number | null;
  outputCostPer1m: number | null;
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  catalogued: boolean;
}

/** Round label for display. */
export function engineRoundLabel(round: EngineRoundKind): string {
  if (typeof round === "string") {
    switch (round) {
      case "prep":
        return "Prep";
      case "positions":
        return "Positions";
      case "revision":
        return "Revision";
      case "critique":
        return "Critique";
    }
  }
  return `Cross-examination ${round.cross}`;
}

/** Stable key for a round (for grouping entries). */
export function engineRoundKey(round: EngineRoundKind): string {
  return typeof round === "string" ? round : `cross-${round.cross}`;
}

export const DEFAULT_ENGINE_TOOL_POLICY: EngineToolPolicy = {
  attachments: true,
  web: true,
  verify: true,
  workspace_files: true,
  shell: { enabled: false, unsandboxed: false, timeout_secs: 30, max_output_bytes: 16384 },
  max_calls_per_turn: 2,
  max_iterations: 2,
  approval: "auto",
};

export const DEFAULT_ENGINE_PROTOCOL: EngineProtocolPolicy = {
  max_rounds: 3,
  max_principals: 8,
  interactive: true,
  tiers: {
    positions: "high",
    cross: "medium",
    revision: "high",
    subtask: "low",
    utility: "low",
    record: "high",
  },
  concurrency: 4,
};

export const DEFAULT_ENGINE_SEATS: EngineSeat[] = [
  { id: "george", name: "George", provider: "openai", model: "auto" },
  { id: "cathy", name: "Cathy", provider: "anthropic", model: "auto" },
  { id: "grace", name: "Grace", provider: "google", model: "auto" },
  { id: "douglas", name: "Douglas", provider: "deepseek", model: "auto" },
  { id: "kate", name: "Kate", provider: "kimi", model: "auto" },
  { id: "quinn", name: "Quinn", provider: "qwen", model: "auto" },
  { id: "mary", name: "Mary", provider: "minimax", model: "auto" },
  { id: "zara", name: "Zara", provider: "zhipu", model: "auto" },
];
