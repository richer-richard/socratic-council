/**
 * @fileoverview Socratic Council Core
 *
 * Wired into apps/desktop (used by Chat.tsx + tests):
 *   - argmap                — live argument map extraction
 *   - conflict              — regex-based conflict detection
 *   - cost                  — per-agent cost ledger
 *   - factcheck             — inline fact-check pipeline (fix 5.1e)
 *   - fairness              — turn-taking fairness manager
 *   - memory                — sliding-window conversation memory
 *   - oracle (assessVerification only) — claim verifier
 *   - reflection            — draft → revise loop (fix 5.1b)
 *   - semanticBidding       — LLM-derived relevance scoring (fix 5.1d)
 *   - semanticConflict      — NLI conflict confirmation (fix 5.1c)
 *   - summarize             — long-session memory summarizer (fix 5.1a)
 *
 * Provider-agnostic helpers used only by `council.ts` (legacy SDK
 * orchestrator; not invoked by the desktop app — see fix 5.1f notes):
 *   - bidding               — keyword-based bid scoring
 *   - council               — full SDK orchestrator (only its types/tests)
 *   - whisper               — WhisperManager
 *   - oracle.DuckDuckGoOracle — JSON instant-answer fetcher
 *
 * The legacy exports are intentionally kept so council.test.ts continues
 * to pass; their absence from the desktop app's call graph is a known
 * architectural state, not a bug.
 */

export * from "./bidding.js";
export * from "./council.js";
export * from "./whisper.js";
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
