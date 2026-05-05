/**
 * @fileoverview Socratic Council Core
 *
 * Wired into apps/desktop (used by Chat.tsx + tests):
 *   - argmap                — live argument map extraction
 *   - conflict              — regex-based conflict detection
 *   - cost                  — per-agent cost ledger
 *   - factcheck             — inline fact-check pipeline
 *   - fairness              — turn-taking fairness manager
 *   - memory                — sliding-window conversation memory
 *   - oracle (assessVerification only) — claim verifier
 *   - reflection            — draft → revise loop
 *   - semanticBidding       — LLM-derived relevance scoring
 *   - semanticConflict      — NLI conflict confirmation
 *   - summarize             — long-session memory summarizer
 */

export * from "./conflict.js";
export * from "./fairness.js";
export * from "./cost.js";
export * from "./oracle.js";
export * from "./memory.js";
export * from "./summarize.js";
export * from "./semanticConflict.js";
export * from "./semanticBidding.js";
export * from "./reflection.js";
export * from "./factcheck.js";
export * from "./argmap.js";
export * from "./argmap.export.js";
export * from "./peerEvaluation.js";
