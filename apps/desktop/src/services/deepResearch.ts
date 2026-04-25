/**
 * Deep Research Report generator.
 *
 * Runs a four-phase agentic loop (plan → research → synthesize → format) on
 * a completed Socratic Council discussion to produce a structured analytical
 * report with inline citations. All phases call the shared provider SDK via
 * `callProvider`, reusing existing transport/proxy/cancellation.
 */

import { callProvider, type ChatMessage as APIChatMessage } from "./api";
import type {
  DeepResearchReportSnapshot,
  ModeratorConclusionSnapshot,
  ResearchCitation,
  ResearchConfidence,
  ResearchReportPhase,
  ResearchSection,
  ResearchSubQuestion,
} from "./sessions";
import type { Provider, ProviderCredential, ProxyConfig } from "../stores/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  id: string;
  speaker: string;
  text: string;
}

export interface DeepResearchInput {
  provider: Provider;
  credential: ProviderCredential;
  model: string;
  proxy?: ProxyConfig;
  topic: string;
  transcript: TranscriptMessage[];
  conclusion: ModeratorConclusionSnapshot;
  onPhase?: (phase: ResearchReportPhase, partial: DeepResearchReportSnapshot) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = `You are a research planner preparing a deep-research report on a completed group discussion.
Your task: identify 5 to 8 specific analytical sub-questions whose answers together would form a comprehensive report.

Guidelines:
- Sub-questions must surface the real disagreements, the evidence gaps, the tradeoffs, and the practical implications. Do not merely restate the conclusion.
- Each sub-question should be answerable from the transcript by extracting claims, evidence, or reasoning.
- Favor specificity over breadth; avoid restating the same question in different words.
- Return STRICTLY valid JSON in this shape and nothing else:
{"subQuestions":[{"id":"q1","question":"..."},{"id":"q2","question":"..."}]}
No prose, no markdown fences, no commentary.`;

const RESEARCHER_SYSTEM = `You are a research reader. Given one sub-question and a full discussion transcript, extract every relevant claim, counter-claim, concrete example, and piece of evidence.

Rules:
- Cite by message id. Only use ids visible in the transcript (format: <msg_id_here>). Never invent ids.
- Preserve nuance: note contradictions, uncertainty, and minority positions.
- Rate your overall confidence in the answer to this sub-question as "high", "medium", or "low".
- In quotes, keep the original language of the speaker. Do not translate.
- Return STRICTLY valid JSON in this shape and nothing else:
{"findings":"markdown summary with inline [c1],[c2] citation tokens","citations":[{"id":"c1","messageId":"msg_xxx","quote":"..."}],"confidence":"high"}
Citation ids are local to this sub-question (c1, c2, ...); the system will renumber them globally.
No prose, no markdown fences around the JSON.`;

const SYNTHESIZER_SYSTEM = `You are a research synthesist. You have a set of sub-question findings extracted from a group discussion.

Your job:
- Identify areas of genuine consensus across sub-questions.
- Identify areas of live disagreement and what the disagreement rests on.
- Identify areas where the evidence is inconclusive.
- Produce a structured outline (3-6 section headings) for a final analytical essay.
- Tag each section with an overall confidence rating (high/medium/low).

Return STRICTLY valid JSON in this shape and nothing else:
{"outline":[{"id":"s1","heading":"...","notes":"what this section should cover and which citation ids belong in it","confidence":"high"}]}
No prose, no markdown fences.`;

const FORMATTER_SYSTEM = `You are a research writer. Write a measured, analytical essay of 600-1200 words using the provided outline and citation ledger.

Tone and style:
- Hedge when uncertain. Do not project more confidence than the evidence supports.
- Narrative prose flow. Short paragraphs are fine. Use bullets ONLY when a list is the most honest format.
- Inline citations: embed them as [c1], [c2], [c3], etc. referring to the provided citation ledger. Every factual claim that traces to the transcript should carry a citation token.
- Preserve nuance: do not flatten disagreements into a single takeaway.
- Be explicit about confidence levels in prose, e.g. "with moderate confidence…" or "the evidence is inconclusive…".
- Match the language of the transcript — if the discussion was in Chinese, write the report in Chinese. Never silently switch languages.

OUTPUT FORMAT — plain text with delimiters. NO JSON. NO escaping required.

Start your response EXACTLY like this, with each delimiter on its own line:

===TITLE===
Your 6-10 word headline goes here on a single line

===ABSTRACT===
A 3-4 sentence narrative lede introducing the analysis.
Multiple sentences in plain prose.

===SECTION | id=s1 | heading=Your First Heading | confidence=high===
Full body paragraph 1. Write real prose. Use [c1], [c2] inline citation tokens as needed.

Paragraph 2 continues here. Free markdown is fine: **bold**, *italics*, \`code\`, lists if truly needed.

===SECTION | id=s2 | heading=Another Heading | confidence=medium===
More body content. Write 3 to 6 sections total, each one covering a distinct analytical angle.

===END===

Critical rules:
- Every delimiter line (===TITLE===, ===ABSTRACT===, ===SECTION | ... ===, ===END===) MUST be on its own line with no prefix, suffix, quoting, or indentation.
- The section header format is EXACTLY: ===SECTION | id=<id> | heading=<heading text> | confidence=<high|medium|low>===
- Use the section ids and headings from the provided outline.
- Do NOT wrap the output in JSON, code fences, markdown blockquotes, or any other container.
- Do NOT escape quotes, newlines, backslashes, or any character — write plain text naturally.
- End with ===END=== on its own line.`;

// ---------------------------------------------------------------------------
// Utility: safe JSON extraction
// ---------------------------------------------------------------------------

/**
 * Find the substring from `start` that forms a balanced JSON object/array.
 * Tracks braces/brackets AND strings (to ignore brackets inside strings).
 * Returns the slice of `raw` containing a complete top-level JSON value,
 * or null if no balanced closing was found.
 */
function sliceBalancedJson(raw: string, start: number): string | null {
  const open = raw[start];
  if (open !== "{" && open !== "[") return null;
  const closeChar = open === "{" ? "}" : "]";
  const openChar = open;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Attempt to repair common JSON issues that break `JSON.parse`:
 * - Trailing commas before `]` or `}`.
 * - Unescaped literal newlines inside string values (replace with `\n`).
 * - Unterminated strings at the very end (caused by token truncation).
 *
 * This is best-effort; returns the input unchanged if no repair helps.
 */
function repairJsonString(candidate: string): string {
  let fixed = candidate;

  // 1. Strip trailing commas before `]` or `}`.
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // 2. Escape literal newlines and tabs that appear INSIDE strings.
  //    Walk the string, flipping inString, and replace raw control chars.
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < fixed.length; i += 1) {
    const ch = fixed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  fixed = out;

  // 3. Close an unterminated string at the end.
  if (inString) {
    fixed += '"';
  }

  // 4. Close any still-open braces/brackets at the end (truncation recovery).
  let braceDepth = 0;
  let bracketDepth = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < fixed.length; i += 1) {
    const ch = fixed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
  }
  while (bracketDepth > 0) {
    fixed += "]";
    bracketDepth -= 1;
  }
  while (braceDepth > 0) {
    fixed += "}";
    braceDepth -= 1;
  }

  return fixed;
}

export function extractJson(raw: string): unknown {
  if (!raw) throw new Error("Empty response");

  // Strip markdown code fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw;

  // Locate the first { or [
  const firstBrace = candidate.search(/[{[]/);
  if (firstBrace < 0) throw new Error("No JSON object/array found");

  // First try: take a balanced slice (handles trailing prose after the JSON).
  const balanced = sliceBalancedJson(candidate, firstBrace);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      // fall through to repair attempt on the balanced slice
      try {
        return JSON.parse(repairJsonString(balanced));
      } catch {
        /* fall through */
      }
    }
  }

  // Second try: parse the raw tail as-is.
  const tail = candidate.slice(firstBrace).trim();
  try {
    return JSON.parse(tail);
  } catch {
    /* fall through */
  }

  // Third try: repair the raw tail and parse.
  try {
    return JSON.parse(repairJsonString(tail));
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function confidenceOrMedium(value: unknown): ResearchConfidence {
  return value === "high" || value === "low" ? value : "medium";
}

function buildTranscriptBlock(transcript: TranscriptMessage[]): string {
  const lines = transcript.map((msg) => `<${msg.id}> ${msg.speaker}: ${msg.text.replace(/\n+/g, " ").trim()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase callers
// ---------------------------------------------------------------------------

interface CallPhaseOptions {
  maxRetries?: number;
  retryOnEmpty?: number; // alias for maxRetries
  maxTokens?: number;
  isJsonPhase?: boolean; // controls the retry nudge wording
}

async function callPhase(
  input: DeepResearchInput,
  systemPrompt: string,
  userPrompt: string,
  options: CallPhaseOptions = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? options.retryOnEmpty ?? 1;
  const isJsonPhase = options.isJsonPhase ?? true;
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const messages: APIChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    if (attempt > 0) {
      messages.push({
        role: "user",
        content: isJsonPhase
          ? "Your previous response was not valid JSON. Return ONLY the JSON object described above, with no surrounding prose, explanation, or markdown fences. Make sure every string is properly closed."
          : "Your previous response did not match the required delimiter format. Start again, beginning EXACTLY with `===TITLE===` on its own line. Use the ===TITLE=== / ===ABSTRACT=== / ===SECTION | id=... | heading=... | confidence=...=== / ===END=== delimiter format and do NOT wrap in JSON or code fences.",
      });
    }
    const result = await callProvider(
      input.provider,
      input.credential,
      input.model,
      messages,
      () => {
        /* ignore streaming chunks; we only need final content */
      },
      input.proxy,
      {
        signal: input.signal,
        idleTimeoutMs: 120000,
        requestTimeoutMs: 240000,
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      },
    );
    if (result.success && result.content.trim().length > 0) {
      return result.content;
    }
    lastError = result.error ?? "empty response";
  }
  throw new Error(lastError ?? "phase call failed");
}

async function planPhase(input: DeepResearchInput): Promise<{ id: string; question: string }[]> {
  const userPrompt = [
    `Discussion topic: "${input.topic}"`,
    "",
    `Moderator conclusion (${input.conclusion.status}, score ${input.conclusion.score}/10):`,
    input.conclusion.summary,
    "",
    "Reason:",
    input.conclusion.reason,
    input.conclusion.next ? `\nNext: ${input.conclusion.next}` : "",
    "",
    "Transcript (each line is `<message_id> speaker: text`):",
    buildTranscriptBlock(input.transcript),
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await callPhase(input, PLANNER_SYSTEM, userPrompt);
  const parsed = extractJson(raw) as { subQuestions?: { id?: string; question?: string }[] };
  if (!parsed || !Array.isArray(parsed.subQuestions)) {
    throw new Error("planner did not return subQuestions array");
  }
  const results: { id: string; question: string }[] = [];
  for (let i = 0; i < parsed.subQuestions.length && results.length < 8; i += 1) {
    const entry = parsed.subQuestions[i];
    if (!entry || typeof entry.question !== "string" || entry.question.trim().length === 0) continue;
    results.push({
      id: entry.id ?? `q${i + 1}`,
      question: entry.question.trim(),
    });
  }
  if (results.length === 0) throw new Error("planner returned no usable sub-questions");
  return results;
}

interface ResearchPhaseOutput {
  subQuestions: ResearchSubQuestion[];
  citations: ResearchCitation[];
}

async function researchPhase(
  input: DeepResearchInput,
  planned: { id: string; question: string }[],
): Promise<ResearchPhaseOutput> {
  const transcriptBlock = buildTranscriptBlock(input.transcript);
  const transcriptIds = new Set(input.transcript.map((m) => m.id));

  const runOne = async (
    entry: { id: string; question: string },
  ): Promise<{ subQuestion: ResearchSubQuestion; citations: ResearchCitation[] } | null> => {
    const userPrompt = [
      `Sub-question: ${entry.question}`,
      "",
      "Transcript (each line is `<message_id> speaker: text`):",
      transcriptBlock,
    ].join("\n");
    try {
      const raw = await callPhase(input, RESEARCHER_SYSTEM, userPrompt);
      const parsed = extractJson(raw) as {
        findings?: string;
        citations?: { id?: string; messageId?: string; quote?: string }[];
        confidence?: string;
      };
      const localCitations: ResearchCitation[] = [];
      if (Array.isArray(parsed.citations)) {
        for (const c of parsed.citations) {
          if (!c || typeof c.messageId !== "string") continue;
          if (!transcriptIds.has(c.messageId)) continue; // reject invented ids
          localCitations.push({
            id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : `c${localCitations.length + 1}`,
            messageId: c.messageId,
            quote: typeof c.quote === "string" ? c.quote.trim().slice(0, 280) : "",
          });
        }
      }
      return {
        subQuestion: {
          id: entry.id,
          question: entry.question,
          findings: typeof parsed.findings === "string" ? parsed.findings : "",
          citations: localCitations.map((c) => c.id),
          confidence: confidenceOrMedium(parsed.confidence),
        },
        citations: localCitations,
      };
    } catch (err) {
      return {
        subQuestion: {
          id: entry.id,
          question: entry.question,
          findings: `_(research failed for this sub-question: ${err instanceof Error ? err.message : String(err)})_`,
          citations: [],
          confidence: "low",
        },
        citations: [],
      };
    }
  };

  const results = await Promise.all(planned.map(runOne));

  const subQuestions: ResearchSubQuestion[] = [];
  const globalCitations: ResearchCitation[] = [];
  const citationKey = (c: ResearchCitation) => `${c.messageId}::${c.quote}`;
  const seenKeys = new Map<string, string>(); // key → global id

  for (const result of results) {
    if (!result) continue;
    const localIdToGlobal = new Map<string, string>();
    for (const c of result.citations) {
      const key = citationKey(c);
      let globalId = seenKeys.get(key);
      if (!globalId) {
        globalId = `c${globalCitations.length + 1}`;
        seenKeys.set(key, globalId);
        globalCitations.push({ id: globalId, messageId: c.messageId, quote: c.quote });
      }
      localIdToGlobal.set(c.id, globalId);
    }
    // Rewrite local [cN] and [cN, cM, ...] tokens in findings to global ids.
    // Single regex pass; each id inside a multi-citation bracket is mapped
    // independently. Unknown local ids pass through untouched.
    const findings = result.subQuestion.findings.replace(
      /\[(c\d+(?:\s*,\s*c\d+)*)\]/g,
      (_match, body: string) => {
        const ids = body.split(",").map((s) => s.trim());
        const mapped = ids.map((id) => localIdToGlobal.get(id) ?? id);
        return `[${mapped.join(", ")}]`;
      },
    );
    subQuestions.push({
      ...result.subQuestion,
      findings,
      citations: Array.from(localIdToGlobal.values()),
    });
  }

  return { subQuestions, citations: globalCitations };
}

interface SynthesisOutline {
  outline: { id: string; heading: string; notes: string; confidence: ResearchConfidence }[];
}

async function synthesisPhase(
  input: DeepResearchInput,
  subQuestions: ResearchSubQuestion[],
  citations: ResearchCitation[],
): Promise<SynthesisOutline> {
  const citationLedger = citations
    .map((c) => `[${c.id}] msg=${c.messageId}: "${c.quote.slice(0, 140)}"`)
    .join("\n");
  const findingsBlock = subQuestions
    .map(
      (q) =>
        `Q ${q.id}: ${q.question}\nConfidence: ${q.confidence}\nFindings:\n${q.findings || "_(no findings)_"}`,
    )
    .join("\n\n");

  const userPrompt = [
    `Topic: "${input.topic}"`,
    `Moderator conclusion: ${input.conclusion.status} — ${input.conclusion.summary}`,
    "",
    "Citation ledger (refer to these ids in your outline):",
    citationLedger || "(none)",
    "",
    "Sub-question findings:",
    findingsBlock,
  ].join("\n");

  const raw = await callPhase(input, SYNTHESIZER_SYSTEM, userPrompt);
  const parsed = extractJson(raw) as {
    outline?: { id?: string; heading?: string; notes?: string; confidence?: string }[];
  };
  if (!parsed || !Array.isArray(parsed.outline) || parsed.outline.length === 0) {
    throw new Error("synthesizer did not return outline");
  }
  const outline = parsed.outline
    .map((entry, i): SynthesisOutline["outline"][number] | null => {
      if (!entry || typeof entry.heading !== "string" || !entry.heading.trim()) return null;
      return {
        id: entry.id?.trim() || `s${i + 1}`,
        heading: entry.heading.trim(),
        notes: typeof entry.notes === "string" ? entry.notes : "",
        confidence: confidenceOrMedium(entry.confidence),
      };
    })
    .filter((entry): entry is SynthesisOutline["outline"][number] => Boolean(entry));
  if (outline.length === 0) throw new Error("synthesizer outline was empty after cleanup");
  return { outline };
}

interface FormattedReport {
  title: string;
  abstract: string;
  sections: ResearchSection[];
}

/**
 * Parse the formatter's plain-text delimited output.
 * Format:
 *   ===TITLE===
 *   Title text
 *   ===ABSTRACT===
 *   Abstract text
 *   ===SECTION | id=s1 | heading=Foo | confidence=high===
 *   Body text
 *   ===SECTION | id=s2 | heading=Bar | confidence=medium===
 *   More body text
 *   ===END===
 *
 * This avoids the JSON escaping fragility that breaks on long prose with
 * quotes, newlines, and markdown.
 */
export function parseDelimitedReport(raw: string): FormattedReport {
  // Strip code fences if the model wrapped the output despite instructions.
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```\s*$/, "");
  text = text.trim();

  const lines = text.split(/\r?\n/);
  let currentBlock: "none" | "title" | "abstract" | "section" = "none";
  let buffer: string[] = [];
  let title = "";
  let abstract = "";
  const sections: ResearchSection[] = [];
  let sectionMeta:
    | { id: string; heading: string; confidence: ResearchConfidence }
    | null = null;

  const flush = () => {
    const value = buffer.join("\n").trim();
    if (currentBlock === "title") {
      title = value;
    } else if (currentBlock === "abstract") {
      abstract = value;
    } else if (currentBlock === "section" && sectionMeta) {
      sections.push({ ...sectionMeta, body: value });
    }
    buffer = [];
    sectionMeta = null;
  };

  const parseSectionHeader = (
    line: string,
  ): { id: string; heading: string; confidence: ResearchConfidence } | null => {
    // Accept `===SECTION | id=... | heading=... | confidence=...===`
    // Also accept `===SECTION|id=...|heading=...|confidence=...===` (no spaces).
    const trimmed = line.trim();
    if (!trimmed.startsWith("===SECTION")) return null;
    if (!trimmed.endsWith("===")) return null;
    const inner = trimmed
      .replace(/^===SECTION\s*\|?\s*/, "")
      .replace(/\s*===$/, "")
      .trim();
    const parts = inner.split("|").map((p) => p.trim());
    const meta: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      meta[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }
    const headingValue = meta.heading ?? "";
    const id = (meta.id && meta.id.trim()) || `s${sections.length + 1}`;
    return {
      id,
      heading: headingValue || "Untitled section",
      confidence: confidenceOrMedium(meta.confidence),
    };
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "===TITLE===") {
      flush();
      currentBlock = "title";
      continue;
    }
    if (trimmed === "===ABSTRACT===") {
      flush();
      currentBlock = "abstract";
      continue;
    }
    if (trimmed === "===END===") {
      flush();
      currentBlock = "none";
      continue;
    }
    const sectionHeader = parseSectionHeader(trimmed);
    if (sectionHeader) {
      flush();
      currentBlock = "section";
      sectionMeta = sectionHeader;
      continue;
    }
    buffer.push(rawLine);
  }
  flush();

  if (sections.length === 0) {
    throw new Error(
      "formatter: could not parse any ===SECTION=== blocks from model output",
    );
  }

  return {
    title: title || "Discussion report",
    abstract,
    sections,
  };
}

async function formatterPhase(
  input: DeepResearchInput,
  outline: SynthesisOutline,
  subQuestions: ResearchSubQuestion[],
  citations: ResearchCitation[],
): Promise<FormattedReport> {
  const citationLedger = citations
    .map((c) => `[${c.id}] msg=${c.messageId}: "${c.quote.slice(0, 180)}"`)
    .join("\n");
  const outlineBlock = outline.outline
    .map((s) => `- ${s.id} ${s.heading} (confidence: ${s.confidence})\n  notes: ${s.notes}`)
    .join("\n");
  const findingsDigest = subQuestions
    .map(
      (q) =>
        `Q ${q.id}: ${q.question}\n${q.findings || "_(no findings)_"}`,
    )
    .join("\n\n");

  const userPrompt = [
    `Topic: "${input.topic}"`,
    `Moderator conclusion: ${input.conclusion.status} — ${input.conclusion.summary}`,
    "",
    "Outline for the essay:",
    outlineBlock,
    "",
    "Citation ledger (use these [cN] tokens in the prose):",
    citationLedger || "(none)",
    "",
    "Sub-question findings (for your reference when drafting):",
    findingsDigest,
    "",
    "Write the report now using the ===TITLE=== / ===ABSTRACT=== / ===SECTION=== / ===END=== delimiter format described in the system prompt. Do not output JSON.",
  ].join("\n");

  // The formatter produces a long prose essay. Give it a larger output budget
  // than the default agent maxTokens so it isn't truncated mid-section.
  // Also: if the first parse fails, retry once with a reinforced format reminder.
  let lastParseError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptPrompt =
      attempt === 0
        ? userPrompt
        : `${userPrompt}

IMPORTANT — your previous response did not match the required format. Start your reply EXACTLY with the line \`===TITLE===\` (no quotes, no code fence). Then use only these delimiters on their own lines: \`===TITLE===\`, \`===ABSTRACT===\`, \`===SECTION | id=s1 | heading=... | confidence=high===\`, \`===END===\`. Write plain text bodies between them. Do NOT output JSON. Do NOT wrap in code fences.`;
    const raw = await callPhase(input, FORMATTER_SYSTEM, attemptPrompt, {
      maxTokens: 16000,
      maxRetries: 0,
      isJsonPhase: false,
    });
    try {
      return parseDelimitedReport(raw);
    } catch (err) {
      lastParseError = err;
    }
  }
  throw lastParseError instanceof Error
    ? lastParseError
    : new Error("formatter phase failed to produce a parseable report");
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

function createEmptySnapshot(
  input: DeepResearchInput,
  phase: ResearchReportPhase,
): DeepResearchReportSnapshot {
  return {
    phase,
    title: "",
    abstract: "",
    subQuestions: [],
    sections: [],
    citations: [],
    confidence: "medium",
    generatedAt: Date.now(),
    modelId: input.model,
  };
}

function overallConfidence(sections: ResearchSection[]): ResearchConfidence {
  if (sections.length === 0) return "low";
  let high = 0;
  let low = 0;
  for (const section of sections) {
    if (section.confidence === "high") high += 1;
    else if (section.confidence === "low") low += 1;
  }
  if (high * 2 >= sections.length) return "high";
  if (low * 2 >= sections.length) return "low";
  return "medium";
}

export async function generateDeepResearchReport(
  input: DeepResearchInput,
): Promise<DeepResearchReportSnapshot> {
  const snapshot: DeepResearchReportSnapshot = createEmptySnapshot(input, "planning");
  input.onPhase?.("planning", snapshot);

  let planned: { id: string; question: string }[] = [];
  try {
    planned = await planPhase(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...snapshot,
      phase: "error",
      error: `Planning failed: ${message}`,
      confidence: "low",
      generatedAt: Date.now(),
    };
  }

  snapshot.phase = "research";
  input.onPhase?.("research", snapshot);

  let research: ResearchPhaseOutput;
  try {
    research = await researchPhase(input, planned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...snapshot,
      phase: "error",
      error: `Research failed: ${message}`,
      confidence: "low",
      subQuestions: planned.map((p) => ({
        id: p.id,
        question: p.question,
        findings: "",
        citations: [],
        confidence: "low",
      })),
      generatedAt: Date.now(),
    };
  }

  snapshot.subQuestions = research.subQuestions;
  snapshot.citations = research.citations;
  snapshot.phase = "synthesis";
  input.onPhase?.("synthesis", snapshot);

  let outline: SynthesisOutline;
  try {
    outline = await synthesisPhase(input, research.subQuestions, research.citations);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...snapshot,
      phase: "error",
      error: `Synthesis failed: ${message}`,
      confidence: "low",
      generatedAt: Date.now(),
    };
  }

  snapshot.phase = "formatting";
  input.onPhase?.("formatting", snapshot);

  let formatted: FormattedReport;
  try {
    formatted = await formatterPhase(input, outline, research.subQuestions, research.citations);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...snapshot,
      phase: "error",
      error: `Formatting failed: ${message}`,
      confidence: "low",
      generatedAt: Date.now(),
    };
  }

  const finalSnapshot: DeepResearchReportSnapshot = {
    phase: "complete",
    title: formatted.title,
    abstract: formatted.abstract,
    subQuestions: research.subQuestions,
    sections: formatted.sections,
    citations: research.citations,
    confidence: overallConfidence(formatted.sections),
    generatedAt: Date.now(),
    modelId: input.model,
  };
  input.onPhase?.("complete", finalSnapshot);
  return finalSnapshot;
}

// ---------------------------------------------------------------------------
// Session title generation
// ---------------------------------------------------------------------------

const SESSION_TITLE_SYSTEM = `You name a finished Socratic Council discussion that will appear as a sidebar entry.

OUTPUT: just the title. Nothing else. No quotes, no preamble, no explanation.

Rules — every rule is mandatory:
- 2 to 5 words.
- Title Case.
- ABSOLUTELY no punctuation: no colons, dashes, em-dashes, en-dashes, periods, commas, semicolons, slashes, parentheses, brackets, quotes, ellipses, exclamation marks, question marks.
- No leading or trailing whitespace.
- Concrete and specific to this discussion. Avoid generic words like "Discussion", "Conversation", "Analysis", "Council".
- Match the language of the original discussion topic.`;

export interface SessionTitleInput {
  provider: Provider;
  credential: ProviderCredential;
  model: string;
  proxy?: ProxyConfig;
  topic: string;
  conclusionSummary: string;
  signal?: AbortSignal;
}

function sanitizeSessionTitle(raw: string): string {
  let title = (raw ?? "").trim();
  // Strip surrounding quotes/backticks
  title = title.replace(/^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g, "");
  // Take only the first non-empty line
  const firstLine = title.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  title = firstLine.trim();
  // Remove any disallowed punctuation
  title = title.replace(/[:\-—–_.,;/!?"'`()[\]{}\u2026\u201C\u201D\u2018\u2019]/g, " ");
  // Collapse whitespace
  title = title.replace(/\s+/g, " ").trim();
  // Cap to 5 words
  const words = title.split(" ").filter((word) => word.length > 0).slice(0, 5);
  title = words.join(" ");
  // Hard cap to 60 chars
  return title.slice(0, 60).trim();
}

export async function generateSessionTitle(input: SessionTitleInput): Promise<string> {
  const userPrompt = [
    `Discussion topic: "${input.topic}"`,
    "",
    "Conclusion the council reached:",
    input.conclusionSummary || "(no explicit conclusion)",
    "",
    "Now output the title. Just the title — 2 to 5 words, Title Case, no punctuation.",
  ].join("\n");

  const messages: APIChatMessage[] = [
    { role: "system", content: SESSION_TITLE_SYSTEM },
    { role: "user", content: userPrompt },
  ];

  let lastSanitized = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptMessages =
      attempt === 0
        ? messages
        : [
            ...messages,
            {
              role: "user" as const,
              content:
                "Your last reply did not match the rules. Reply with ONLY the title now: 2 to 5 words, Title Case, no punctuation at all, no quotes, no extra text.",
            },
          ];

    const result = await callProvider(
      input.provider,
      input.credential,
      input.model,
      attemptMessages,
      () => {
        /* ignore streaming chunks */
      },
      input.proxy,
      {
        signal: input.signal,
        idleTimeoutMs: 30000,
        requestTimeoutMs: 60000,
        maxTokens: 64,
      },
    );

    if (!result.success || !result.content) continue;
    const sanitized = sanitizeSessionTitle(result.content);
    if (sanitized.split(" ").length >= 2) return sanitized;
    lastSanitized = sanitized;
  }

  if (lastSanitized) return lastSanitized;
  throw new Error("session title generation failed");
}
