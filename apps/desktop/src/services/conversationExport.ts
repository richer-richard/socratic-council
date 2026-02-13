import type { AgentId, PairwiseConflict } from "@socratic-council/shared";
import type { FileChild } from "docx";

export type ConversationExportFormat = "markdown" | "pdf" | "docx" | "pptx" | "json";

export type ConversationExportMessage = {
  id: string;
  agentId?: string;
  speaker: string;
  model?: string;
  timestamp: number;
  content: string;
  tokens?: { input: number; output: number; reasoning?: number };
  costUSD?: number | null;
};

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatUtcTimestamp(date: Date) {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `${iso.slice(0, 19).replace("T", " ")} UTC`;
}

function safeBaseName(value: string) {
  return value
    .trim()
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
}

const APP_ICON_URL = new URL("../../src-tauri/app-icon.png", import.meta.url).href;

const SPEAKER_PALETTE = [
  "34D399", // emerald
  "60A5FA", // blue
  "F472B6", // pink
  "FBBF24", // amber
  "A78BFA", // violet
  "F87171", // red
  "22D3EE", // cyan
];

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function colorForSpeaker(speaker: string) {
  const idx = hashString(speaker) % SPEAKER_PALETTE.length;
  return SPEAKER_PALETTE[idx];
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return { r, g, b };
}

function mixRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * clamped),
    g: Math.round(a.g + (b.g - a.g) * clamped),
    b: Math.round(a.b + (b.b - a.b) * clamped),
  };
}

async function tryFetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

async function tryFetchDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    return dataUrl;
  } catch {
    return null;
  }
}

type SpeakerExportStats = {
  speaker: string;
  messageCount: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  costUSD: number;
};

type ConversationExportStats = {
  messageCount: number;
  speakerCount: number;
  speakers: SpeakerExportStats[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokensReasoning: number;
  totalCostUSD: number;
};

function computeStats(messages: ConversationExportMessage[]): ConversationExportStats {
  const bySpeaker = new Map<string, SpeakerExportStats>();

  for (const msg of messages) {
    const speaker = msg.speaker || "Unknown";
    const current =
      bySpeaker.get(speaker) ??
      ({
        speaker,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
        costUSD: 0,
      } satisfies SpeakerExportStats);

    current.messageCount += 1;
    if (msg.tokens) {
      current.tokensIn += msg.tokens.input ?? 0;
      current.tokensOut += msg.tokens.output ?? 0;
      current.tokensReasoning += msg.tokens.reasoning ?? 0;
    }
    if (msg.costUSD != null) current.costUSD += msg.costUSD;

    bySpeaker.set(speaker, current);
  }

  const speakers = Array.from(bySpeaker.values()).sort((a, b) =>
    b.messageCount !== a.messageCount ? b.messageCount - a.messageCount : a.speaker.localeCompare(b.speaker)
  );

  const totals = speakers.reduce(
    (acc, s) => {
      acc.totalTokensIn += s.tokensIn;
      acc.totalTokensOut += s.tokensOut;
      acc.totalTokensReasoning += s.tokensReasoning;
      acc.totalCostUSD += s.costUSD;
      return acc;
    },
    { totalTokensIn: 0, totalTokensOut: 0, totalTokensReasoning: 0, totalCostUSD: 0 }
  );

  return {
    messageCount: messages.length,
    speakerCount: speakers.length,
    speakers,
    totalTokensIn: totals.totalTokensIn,
    totalTokensOut: totals.totalTokensOut,
    totalTokensReasoning: totals.totalTokensReasoning,
    totalCostUSD: totals.totalCostUSD,
  };
}

function buildMarkdown(options: {
  topic: string;
  messages: ConversationExportMessage[];
  includeTokens: boolean;
  includeCosts: boolean;
}) {
  const lines: string[] = [];
  lines.push("# Socratic Council Transcript");
  lines.push("");
  lines.push(`**Topic:** ${options.topic}`);
  lines.push(`**Exported:** ${new Date().toLocaleString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of options.messages) {
    const headerParts = [`**${msg.speaker}**`, formatTime(msg.timestamp)];
    if (msg.model) headerParts.splice(1, 0, `(${msg.model})`);
    lines.push(headerParts.join(" · "));

    if (options.includeTokens && msg.tokens) {
      const tokensLine = `${msg.tokens.input}/${msg.tokens.output} tokens`;
      const costLine =
        options.includeCosts && msg.costUSD != null ? ` · $${msg.costUSD.toFixed(4)}` : "";
      lines.push(`_${tokensLine}${costLine}_`);
    } else if (options.includeCosts && msg.costUSD != null) {
      lines.push(`_$${msg.costUSD.toFixed(4)}_`);
    }

    lines.push("");
    lines.push(msg.content.trim());
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function formatCompactNumber(value: number) {
  try {
    return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
  } catch {
    return String(value);
  }
}

function formatInteger(value: number) {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.round(value));
  }
}

function formatUsd(value: number) {
  return `$${value.toFixed(4)}`;
}

type PdfRectDoc = {
  roundedRect?: (
    x: number,
    y: number,
    w: number,
    h: number,
    rx: number,
    ry: number,
    style: "S" | "F" | "DF" | "FD"
  ) => void;
  rect: (x: number, y: number, w: number, h: number, style: "S" | "F" | "DF" | "FD") => void;
};

function pdfRoundedRect(
  doc: PdfRectDoc,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  style: "S" | "F" | "DF" | "FD"
) {
  if (typeof doc.roundedRect === "function") {
    doc.roundedRect(x, y, w, h, radius, radius, style);
    return;
  }
  doc.rect(x, y, w, h, style);
}

async function buildPdfBytes(options: {
  topic: string;
  messages: ConversationExportMessage[];
  includeTokens: boolean;
  includeCosts: boolean;
}): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });

  const margin = 54;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;

  doc.setFont("helvetica", "normal");
  const fg = hexToRgb("0F172A");
  const muted = hexToRgb("475569");
  const cardBg = hexToRgb("F8FAFC");
  const cardBorder = hexToRgb("E2E8F0");
  const headerBg = hexToRgb("0B0F14");
  const headerFg = hexToRgb("F8FAFC");

  const exportedAt = new Date();
  const safeTopic = options.topic?.trim() || "Untitled Topic";
  const messages = options.messages;
  const stats = computeStats(messages);
  const iconDataUrl = await tryFetchDataUrl(APP_ICON_URL);
  const councilAgents = [
    { id: "george", name: "George" },
    { id: "cathy", name: "Cathy" },
    { id: "grace", name: "Grace" },
    { id: "douglas", name: "Douglas" },
    { id: "kate", name: "Kate" },
  ] as const;
  const councilAgentIds: AgentId[] = councilAgents.map((a) => a.id);

  // Cover
  doc.setFillColor(headerBg.r, headerBg.g, headerBg.b);
  doc.rect(0, 0, pageWidth, 132, "F");

  let titleX = margin;
  if (iconDataUrl) {
    try {
      doc.addImage(iconDataUrl, "PNG", margin, 28, 42, 42);
      titleX = margin + 54;
    } catch {
      // ignore image load failures
    }
  }

  doc.setTextColor(headerFg.r, headerFg.g, headerFg.b);
  doc.setFontSize(20);
  doc.text("SOCRATIC COUNCIL", titleX, 52);
  doc.setFontSize(18);
  doc.text("Socratic Seminar Transcript", titleX, 74);

  doc.setFontSize(12);
  doc.setTextColor(headerFg.r, headerFg.g, headerFg.b);
  doc.text(`Topic: ${safeTopic}`, titleX, 96, { maxWidth: pageWidth - titleX - margin });
  doc.setTextColor(headerFg.r, headerFg.g, headerFg.b);
  doc.text(`Exported: ${formatUtcTimestamp(exportedAt)}`, titleX, 116);

  // Summary cards
  const cardGap = 12;
  const cardY = 156;
  const cardH = 62;
  const cardW = (maxWidth - cardGap * 2) / 3;

  const cards = [
    { label: "Messages", value: formatCompactNumber(stats.messageCount) },
    { label: "Speakers", value: formatCompactNumber(stats.speakerCount) },
    {
      label: "Tokens (in/out)",
      value: `${formatCompactNumber(stats.totalTokensIn)}/${formatCompactNumber(stats.totalTokensOut)}`,
    },
  ];

  if (!options.includeTokens) {
    cards[2] = { label: "Export", value: "Transcript" };
  }

  for (let i = 0; i < cards.length; i += 1) {
    const x = margin + i * (cardW + cardGap);
    doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
    doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
    pdfRoundedRect(doc, x, cardY, cardW, cardH, 10, "DF");

    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(10);
    doc.text(cards[i].label, x + 14, cardY + 22);

    doc.setTextColor(fg.r, fg.g, fg.b);
    doc.setFontSize(18);
    doc.text(cards[i].value, x + 14, cardY + 46);
  }

  // Speaker distribution chart
  const chartX = margin;
  const chartY = cardY + cardH + 18;
  const chartW = maxWidth;
  const chartPad = 14;
  const barLabelW = 120;
  const barRowH = 18;
  const speakerRowsRaw = stats.speakers.map((s) => ({ speaker: s.speaker, messageCount: s.messageCount }));
  const maxSpeakerRows = 10;
  const speakerRows = speakerRowsRaw.slice(0, maxSpeakerRows);
  if (speakerRowsRaw.length > maxSpeakerRows) {
    const otherCount = speakerRowsRaw
      .slice(maxSpeakerRows)
      .reduce((total, s) => total + s.messageCount, 0);
    speakerRows.push({ speaker: `Other (${speakerRowsRaw.length - maxSpeakerRows})`, messageCount: otherCount });
  }
  const chartHeaderH = 34;
  const chartFooterH = 18;
  const chartH = chartPad * 2 + chartHeaderH + speakerRows.length * barRowH + chartFooterH;

  doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
  doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
  pdfRoundedRect(doc, chartX, chartY, chartW, chartH, 10, "DF");

  doc.setTextColor(muted.r, muted.g, muted.b);
  doc.setFontSize(11);
  doc.text("Messages by Speaker", chartX + chartPad, chartY + 22);

  const barMax = Math.max(1, ...speakerRows.map((s) => s.messageCount));
  const barAreaX = chartX + chartPad;
  const barAreaY = chartY + chartPad + chartHeaderH;
  const barAreaW = chartW - chartPad * 2;
  doc.setFontSize(10);
  for (let i = 0; i < speakerRows.length; i += 1) {
    const s = speakerRows[i]!;
    const rowY = barAreaY + i * barRowH;
    const label = s.speaker.length > 18 ? `${s.speaker.slice(0, 17)}…` : s.speaker;

    const barX = barAreaX + barLabelW;
    const barW = Math.max(0, barAreaW - barLabelW - 40);
    const valueW = (s.messageCount / barMax) * barW;

    const accent = hexToRgb(colorForSpeaker(s.speaker));
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(label, barAreaX, rowY + 12);

    doc.setFillColor(cardBorder.r, cardBorder.g, cardBorder.b);
    doc.rect(barX, rowY + 4, barW, 10, "F");

    doc.setFillColor(accent.r, accent.g, accent.b);
    doc.rect(barX, rowY + 4, valueW, 10, "F");

    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(String(s.messageCount), barX + barW + 10, rowY + 12);
  }

  if (options.includeCosts) {
    // Cost ledger
    const ledgerX = margin;
    const ledgerY = chartY + chartH + 18;
    const ledgerW = maxWidth;
    const ledgerPad = 14;
    const ledgerHeaderH = 32;
    const ledgerRowH = 18;
    const ledgerFooterH = 28;

    const totals = messages.reduce(
      (acc, m) => {
        acc.input += m.tokens?.input ?? 0;
        acc.output += m.tokens?.output ?? 0;
        return acc;
      },
      { input: 0, output: 0 }
    );

    const costRows = councilAgents.map((agent) => {
      const forAgent = messages.filter((m) => {
        const raw = typeof m.agentId === "string" ? m.agentId : m.speaker.toLowerCase();
        return raw === agent.id || m.speaker === agent.name;
      });
      const inputTokens = forAgent.reduce((sum, m) => sum + (m.tokens?.input ?? 0), 0);
      const outputTokens = forAgent.reduce((sum, m) => sum + (m.tokens?.output ?? 0), 0);
      const priced = forAgent.some((m) => m.costUSD != null);
      const estimatedUSD = forAgent.reduce((sum, m) => sum + (m.costUSD ?? 0), 0);
      return { name: agent.name, inputTokens, outputTokens, priced, estimatedUSD };
    });

    const anyPricing = costRows.some((r) => r.priced);
    const totalEstimatedUSD = costRows.reduce((sum, r) => sum + (r.priced ? r.estimatedUSD : 0), 0);
    const ledgerH = ledgerPad * 2 + ledgerHeaderH + costRows.length * ledgerRowH + ledgerFooterH;

    doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
    doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
    pdfRoundedRect(doc, ledgerX, ledgerY, ledgerW, ledgerH, 10, "DF");

    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(11);
    doc.text("Cost Ledger", ledgerX + ledgerPad, ledgerY + 22);

    // Badge (tokens)
    const badgeText = `${formatInteger(totals.input + totals.output)} tokens`;
    doc.setFontSize(10);
    const badgeW = Math.min(180, doc.getTextWidth(badgeText) + 18);
    const badgeX = ledgerX + ledgerW - ledgerPad - badgeW;
    const badgeY = ledgerY + 10;
    doc.setFillColor(cardBorder.r, cardBorder.g, cardBorder.b);
    pdfRoundedRect(doc, badgeX, badgeY, badgeW, 20, 10, "F");
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(badgeText, badgeX + 9, badgeY + 14);

    let rowY = ledgerY + ledgerPad + ledgerHeaderH;
    doc.setFontSize(10);
    for (const row of costRows) {
      doc.setTextColor(fg.r, fg.g, fg.b);
      doc.text(row.name, ledgerX + ledgerPad, rowY + 12);

      const costLabel = row.priced ? formatUsd(row.estimatedUSD) : "—";
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.text(
        `${row.inputTokens}/${row.outputTokens} · ${costLabel}`,
        ledgerX + ledgerW - ledgerPad,
        rowY + 12,
        { align: "right" }
      );
      rowY += ledgerRowH;
    }

    // Footer total
    doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
    doc.line(ledgerX + ledgerPad, rowY + 6, ledgerX + ledgerW - ledgerPad, rowY + 6);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text("Estimated total", ledgerX + ledgerPad, rowY + 22);
    doc.setTextColor(fg.r, fg.g, fg.b);
    doc.text(
      anyPricing ? formatUsd(totalEstimatedUSD) : "Pricing not configured",
      ledgerX + ledgerW - ledgerPad,
      rowY + 22,
      {
        align: "right",
      }
    );
  }

  // Transcript pages
  doc.addPage();
  let y = margin;
  const lineH = 14;
  const cardPad = 14;

  for (const msg of messages) {
    const headerParts = [`${msg.speaker}`];
    if (msg.model) headerParts.push(`(${msg.model})`);
    headerParts.push(formatTime(msg.timestamp));
    const headerLine = headerParts.join(" · ");

    const metaLine = (() => {
      const parts: string[] = [];
      if (options.includeTokens && msg.tokens) {
        const inOut = `${msg.tokens.input ?? 0}/${msg.tokens.output ?? 0} tokens`;
        const reasoning =
          msg.tokens.reasoning != null && msg.tokens.reasoning > 0 ? ` · r:${msg.tokens.reasoning}` : "";
        parts.push(`${inOut}${reasoning}`);
      }
      if (options.includeCosts && msg.costUSD != null) parts.push(formatUsd(msg.costUSD));
      return parts.join(" · ");
    })();

    doc.setFontSize(11);
    const contentMaxW = maxWidth - cardPad * 2;
    const paragraphs = msg.content.trim().split("\n");
    const contentLines: string[] = [];
    for (const p of paragraphs) {
      const trimmed = p.replace(/\s+$/g, "");
      if (!trimmed) {
        contentLines.push("");
        continue;
      }
      const wrapped = doc.splitTextToSize(trimmed, contentMaxW) as string[];
      contentLines.push(...wrapped);
    }

    const headerH = 18;
    const metaH = metaLine ? 14 : 0;
    const contentH = Math.max(1, contentLines.length) * lineH;
    const blockH = cardPad + headerH + (metaH ? metaH + 6 : 6) + contentH + cardPad;

    if (y + blockH > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }

    const cardX = margin;
    const cardY2 = y;
    doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
    doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
    pdfRoundedRect(doc, cardX, cardY2, maxWidth, blockH, 10, "DF");

    const accent = hexToRgb(colorForSpeaker(msg.speaker));
    doc.setFillColor(accent.r, accent.g, accent.b);
    doc.rect(cardX, cardY2, 5, blockH, "F");

    let textY = cardY2 + cardPad + 2;
    doc.setTextColor(fg.r, fg.g, fg.b);
    doc.setFontSize(12);
    doc.text(headerLine, cardX + cardPad, textY);
    textY += headerH;

    if (metaLine) {
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(10);
      doc.text(metaLine, cardX + cardPad, textY);
      textY += metaH + 6;
    } else {
      textY += 6;
    }

    doc.setTextColor(fg.r, fg.g, fg.b);
    doc.setFontSize(11);
    for (const line of contentLines.length ? contentLines : [""]) {
      doc.text(line, cardX + cardPad, textY);
      textY += lineH;
    }

    y += blockH + 14;
  }

  // Conflict graph (end of export)
  {
    let conflicts: PairwiseConflict[] = [];
    type ConflictMessage = { id: string; agentId: AgentId; content: string; timestamp: number };
    try {
      const { ConflictDetector } = await import("@socratic-council/core");
      const detector = new ConflictDetector(60, 12);
      const councilAgentIdSet = new Set<AgentId>(councilAgentIds);
      const isCouncilAgentId = (value: string): value is AgentId =>
        councilAgentIdSet.has(value as AgentId);
      const councilMessages = messages
        .map((m): ConflictMessage | null => {
          const raw = typeof m.agentId === "string" ? m.agentId : m.speaker.toLowerCase();
          if (!isCouncilAgentId(raw)) return null;
          return {
            id: m.id,
            agentId: raw,
            content: m.content,
            timestamp: m.timestamp,
          };
        })
        .filter((m): m is ConflictMessage => m != null);

      if (councilMessages.length >= 2) {
        conflicts = detector.evaluateAll(councilMessages, councilAgentIds).pairs;
      }
    } catch {
      conflicts = [];
    }

    doc.addPage();
    const titleY = margin;
    doc.setTextColor(fg.r, fg.g, fg.b);
    doc.setFontSize(18);
    doc.text("Conflict Graph", margin, titleY);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(10);
    doc.text("Heuristic pairwise tension scores (0–100%). Higher = more sustained disagreement.", margin, titleY + 18);

    if (conflicts.length === 0) {
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(12);
      doc.text("Not enough agent messages to compute conflicts.", margin, titleY + 52);
    } else {
      const idToName = new Map(councilAgents.map((a) => [a.id, a.name] as const));

      const agentHex: Record<string, string> = {
        george: "3B82F6",
        cathy: "F59E0B",
        grace: "10B981",
        douglas: "F87171",
        kate: "2DD4BF",
      };

      const low = { r: 59, g: 130, b: 246 };
      const high = { r: 220, g: 38, b: 38 };

      const graphX = margin;
      const graphY = titleY + 40;
      const graphW = maxWidth;
      const graphH = 300;

      doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
      doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
      pdfRoundedRect(doc, graphX, graphY, graphW, graphH, 10, "DF");

      const cx = graphX + graphW / 2;
      const cy = graphY + graphH / 2 - 10;
      const radius = Math.min(graphW, graphH) / 2 - 70;

      const positions = councilAgents.map((a, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / councilAgents.length;
        return {
          id: a.id,
          name: a.name,
          x: cx + radius * Math.cos(angle),
          y: cy + radius * Math.sin(angle),
        };
      });

      const posById = new Map(positions.map((p) => [p.id, p] as const));
      const sortedPairs = [...conflicts].sort((a, b) => b.score - a.score);

      // Edges
      for (const pair of conflicts) {
        const a = pair.agents[0];
        const b = pair.agents[1];
        const pA = posById.get(a);
        const pB = posById.get(b);
        if (!pA || !pB) continue;

        const c = mixRgb(low, high, pair.score);
        doc.setDrawColor(c.r, c.g, c.b);
        doc.setLineWidth(1 + Math.min(1, pair.score) * 3);
        doc.line(pA.x, pA.y, pB.x, pB.y);
      }

      // Nodes
      doc.setLineWidth(1);
      for (const p of positions) {
        const hex = agentHex[p.id] ?? "64748B";
        const rgb = hexToRgb(hex);

        doc.setFillColor(rgb.r, rgb.g, rgb.b);
        doc.circle(p.x, p.y, 10, "F");
        doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
        doc.circle(p.x, p.y, 4, "F");

        doc.setTextColor(fg.r, fg.g, fg.b);
        doc.setFontSize(10);
        doc.text(p.name, p.x, p.y + 26, { align: "center" });
      }

      // Legend
      const legendY = graphY + graphH - 34;
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(9);
      doc.text("Low", graphX + 18, legendY + 12);
      doc.text("High", graphX + graphW - 18, legendY + 12, { align: "right" });

      const legendX = graphX + 50;
      const legendW = graphW - 100;
      const legendH = 8;
      const steps = 18;
      for (let s = 0; s < steps; s += 1) {
        const t = s / (steps - 1);
        const c = mixRgb(low, high, t);
        doc.setFillColor(c.r, c.g, c.b);
        doc.rect(legendX + (legendW * s) / steps, legendY + 4, legendW / steps + 1, legendH, "F");
      }

      // Top tensions list
      const listY = graphY + graphH + 22;
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(11);
      doc.text("Top tensions", margin, listY);

      let rowY = listY + 16;
      doc.setFontSize(10);
      for (const pair of sortedPairs) {
        const a = idToName.get(pair.agents[0]) ?? pair.agents[0];
        const b = idToName.get(pair.agents[1]) ?? pair.agents[1];
        const label = `${a} ↔ ${b}`;
        doc.setTextColor(fg.r, fg.g, fg.b);
        doc.text(label, margin, rowY);
        doc.setTextColor(muted.r, muted.g, muted.b);
        doc.text(`${Math.round(pair.score * 100)}%`, margin + maxWidth, rowY, { align: "right" });
        rowY += 16;
        if (rowY > pageHeight - margin - 20) break;
      }
    }
  }

  // Footers
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const footer = `Socratic Council · Page ${i} of ${pageCount}`;
    doc.text(footer, margin, pageHeight - 28);
  }

  const buffer = doc.output("arraybuffer");
  return new Uint8Array(buffer);
}

async function buildDocxBytes(options: {
  topic: string;
  messages: ConversationExportMessage[];
  includeTokens: boolean;
  includeCosts: boolean;
}): Promise<Uint8Array> {
  const docx = await import("docx");
  const {
    AlignmentType,
    BorderStyle,
    Document,
    HeadingLevel,
    ImageRun,
    Packer,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = docx;

  const children: FileChild[] = [];
  const exportedAt = new Date();
  const safeTopic = options.topic?.trim() || "Untitled Topic";
  const stats = computeStats(options.messages);

  const appIconBytes = await tryFetchBytes(APP_ICON_URL);
  if (appIconBytes) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            type: "png",
            data: appIconBytes,
            transformation: { width: 64, height: 64 },
          }),
        ],
      })
    );
  }
  children.push(
    new Paragraph({
      text: "Socratic Council Transcript",
      heading: HeadingLevel.TITLE,
    })
  );
  children.push(new Paragraph({ text: `Topic: ${safeTopic}` }));
  children.push(new Paragraph({ text: `Exported: ${exportedAt.toLocaleString()}` }));
  children.push(new Paragraph({ text: "" }));

  const headerCell = (text: string) =>
    new TableCell({
      shading: { type: ShadingType.SOLID, color: "0B0F14" },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: "0B0F14" },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "0B0F14" },
        left: { style: BorderStyle.SINGLE, size: 1, color: "0B0F14" },
        right: { style: BorderStyle.SINGLE, size: 1, color: "0B0F14" },
      },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: true, color: "F8FAFC" })],
        }),
      ],
    });

  const bodyCell = (text: string) =>
    new TableCell({
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
        left: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
        right: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      },
      children: [new Paragraph({ children: [new TextRun({ text })] })],
    });

  const summaryTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          headerCell("Speaker"),
          headerCell("Messages"),
          headerCell("Tokens (in/out)"),
          headerCell("Cost"),
        ],
      }),
      ...stats.speakers.map(
        (s) =>
          new TableRow({
            children: [
              bodyCell(s.speaker),
              bodyCell(String(s.messageCount)),
              bodyCell(`${s.tokensIn}/${s.tokensOut}`),
              bodyCell(options.includeCosts && s.costUSD > 0 ? formatUsd(s.costUSD) : "—"),
            ],
          })
      ),
    ],
  });

  children.push(new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_2 }));
  children.push(summaryTable);
  children.push(new Paragraph({ text: "" }));

  for (const msg of options.messages) {
    const header = `${msg.speaker}${msg.model ? ` (${msg.model})` : ""} · ${formatTime(msg.timestamp)}`;
    children.push(new Paragraph({ text: header, heading: HeadingLevel.HEADING_3 }));

    if (options.includeTokens && msg.tokens) {
      const tokensLine = `${msg.tokens.input}/${msg.tokens.output} tokens`;
      const costLine =
        options.includeCosts && msg.costUSD != null ? ` · $${msg.costUSD.toFixed(4)}` : "";
      children.push(new Paragraph({ text: `${tokensLine}${costLine}` }));
    } else if (options.includeCosts && msg.costUSD != null) {
      children.push(new Paragraph({ text: `$${msg.costUSD.toFixed(4)}` }));
    }

    const contentLines = msg.content.trim().split("\n");
    const runs = contentLines.flatMap((line, idx) => {
      const run = new TextRun({ text: line });
      return idx === 0 ? [run] : [new TextRun({ text: line, break: 1 })];
    });
    children.push(new Paragraph({ children: runs.length > 0 ? runs : [new TextRun({ text: "" })] }));

    children.push(new Paragraph({ text: "" }));
  }

  const document = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(document);
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

async function buildPptxBytes(options: {
  topic: string;
  messages: ConversationExportMessage[];
}): Promise<Uint8Array> {
  const { default: PptxGen } = await import("pptxgenjs");
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Socratic Council";
  pptx.title = "Socratic Council Transcript";
  pptx.subject = options.topic;

  const bg = "0B0F14";
  const fg = "F8FAFC";
  const muted = "9AA6BD";
  const card = "111827";
  const border = "1F2937";

  const iconDataUrl = await tryFetchDataUrl(APP_ICON_URL);
  const stats = computeStats(options.messages);

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: bg };
  if (iconDataUrl) {
    try {
      titleSlide.addImage({ data: iconDataUrl, x: 0.6, y: 0.55, w: 0.55, h: 0.55 });
    } catch {
      // ignore image failures
    }
  }
  titleSlide.addText("Socratic Council Transcript", {
    x: 0.6,
    y: 1.1,
    w: 12.1,
    h: 0.8,
    fontSize: 36,
    color: fg,
    bold: true,
  });
  titleSlide.addText(`Topic: ${options.topic}`, {
    x: 0.6,
    y: 2.1,
    w: 12.1,
    h: 0.6,
    fontSize: 18,
    color: muted,
  });
  titleSlide.addText(`Exported: ${new Date().toLocaleString()}`, {
    x: 0.6,
    y: 2.7,
    w: 12.1,
    h: 0.5,
    fontSize: 14,
    color: muted,
  });

  // Snapshot slide (simple infographic)
  const snapshot = pptx.addSlide();
  snapshot.background = { color: bg };
  snapshot.addText("Council Snapshot", {
    x: 0.6,
    y: 0.5,
    w: 12.1,
    h: 0.6,
    fontSize: 28,
    color: fg,
    bold: true,
  });
  snapshot.addText(options.topic, {
    x: 0.6,
    y: 1.15,
    w: 12.1,
    h: 0.4,
    fontSize: 14,
    color: muted,
  });

  const metricY = 1.75;
  const metricW = 3.9;
  const metricH = 1.1;
  const metrics = [
    { label: "Messages", value: String(stats.messageCount) },
    { label: "Speakers", value: String(stats.speakerCount) },
    { label: "Tokens (in/out)", value: `${stats.totalTokensIn}/${stats.totalTokensOut}` },
  ];
  for (let i = 0; i < metrics.length; i += 1) {
    const x = 0.6 + i * (metricW + 0.25);
    snapshot.addShape(pptx.ShapeType.roundRect, {
      x,
      y: metricY,
      w: metricW,
      h: metricH,
      fill: { color: card },
      line: { color: border, width: 1 },
    });
    snapshot.addText(metrics[i].label, {
      x: x + 0.25,
      y: metricY + 0.15,
      w: metricW - 0.5,
      h: 0.3,
      fontSize: 12,
      color: muted,
    });
    snapshot.addText(metrics[i].value, {
      x: x + 0.25,
      y: metricY + 0.45,
      w: metricW - 0.5,
      h: 0.6,
      fontSize: 24,
      color: fg,
      bold: true,
    });
  }

  snapshot.addText("Messages by Speaker", {
    x: 0.6,
    y: 3.1,
    w: 12.1,
    h: 0.4,
    fontSize: 14,
    color: muted,
    bold: true,
  });

  const chartX = 0.6;
  const chartY = 3.55;
  const rowH = 0.45;
  const barMax = Math.max(1, ...stats.speakers.map((s) => s.messageCount));
  for (let i = 0; i < Math.min(10, stats.speakers.length); i += 1) {
    const s = stats.speakers[i];
    const y = chartY + i * rowH;
    const accent = colorForSpeaker(s.speaker);

    snapshot.addShape(pptx.ShapeType.rect, {
      x: chartX,
      y: y + 0.08,
      w: 0.14,
      h: 0.22,
      fill: { color: accent },
      line: { color: accent },
    });
    snapshot.addText(s.speaker, {
      x: chartX + 0.22,
      y,
      w: 3.2,
      h: rowH,
      fontSize: 12,
      color: fg,
    });

    const barX = chartX + 3.55;
    const barW = 7.6;
    snapshot.addShape(pptx.ShapeType.roundRect, {
      x: barX,
      y: y + 0.13,
      w: barW,
      h: 0.14,
      fill: { color: border },
      line: { color: border },
    });
    snapshot.addShape(pptx.ShapeType.roundRect, {
      x: barX,
      y: y + 0.13,
      w: (s.messageCount / barMax) * barW,
      h: 0.14,
      fill: { color: accent },
      line: { color: accent },
    });

    snapshot.addText(String(s.messageCount), {
      x: chartX + 11.25,
      y,
      w: 1.45,
      h: rowH,
      fontSize: 12,
      color: muted,
      align: "right",
    });
  }

  const entries = options.messages.map((m) => {
    const compact = m.content.replace(/\s+/g, " ").trim();
    const clipped = compact.length > 260 ? `${compact.slice(0, 257)}…` : compact;
    return `[${formatTime(m.timestamp)}] ${m.speaker}: ${clipped}`;
  });

  const perSlide = 8;
  for (let i = 0; i < entries.length; i += perSlide) {
    const slide = pptx.addSlide();
    slide.background = { color: bg };
    const chunk = entries.slice(i, i + perSlide);
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.33,
      h: 0.6,
      fill: { color: card },
      line: { color: card },
    });
    slide.addText(`Transcript (${i + 1}–${Math.min(i + perSlide, entries.length)})`, {
      x: 0.6,
      y: 0.16,
      w: 12.1,
      h: 0.4,
      fontSize: 18,
      color: muted,
      bold: true,
    });
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.6,
      y: 0.95,
      w: 12.1,
      h: 6.2,
      fill: { color: card },
      line: { color: border, width: 1 },
    });
    slide.addText(chunk.join("\n\n"), {
      x: 0.9,
      y: 1.15,
      w: 11.5,
      h: 5.85,
      fontSize: 14,
      color: fg,
      valign: "top",
    });
    slide.addText(`Page ${Math.floor(i / perSlide) + 1} of ${Math.ceil(entries.length / perSlide)}`, {
      x: 0.6,
      y: 7.15,
      w: 12.1,
      h: 0.3,
      fontSize: 10,
      color: muted,
      align: "right",
    });
  }

  const out = await pptx.write({ outputType: "uint8array", compression: true });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

async function pickSavePath(format: ConversationExportFormat, defaultBaseName: string) {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");

  const extension =
    format === "markdown"
      ? "md"
      : format === "pdf"
        ? "pdf"
        : format === "docx"
          ? "docx"
          : format === "pptx"
            ? "pptx"
            : "json";

  const filters =
    format === "markdown"
      ? [{ name: "Markdown", extensions: ["md"] }]
      : format === "pdf"
        ? [{ name: "PDF", extensions: ["pdf"] }]
        : format === "docx"
          ? [{ name: "Word", extensions: ["docx"] }]
          : format === "pptx"
            ? [{ name: "PowerPoint", extensions: ["pptx"] }]
            : [{ name: "JSON", extensions: ["json"] }];

  const base = safeBaseName(defaultBaseName) || "socratic-council";
  const path = await save({
    title: "Export Conversation",
    defaultPath: base.endsWith(`.${extension}`) ? base : `${base}.${extension}`,
    filters,
  });
  return path;
}

async function saveBytes(path: string, data: Uint8Array) {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, data, { create: true });
}

function downloadBytes(fileName: string, mime: string, data: Uint8Array) {
  const blob = new Blob([data as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportConversation(options: {
  format: ConversationExportFormat;
  topic: string;
  messages: ConversationExportMessage[];
  includeTokens?: boolean;
  includeCosts?: boolean;
  baseFileName?: string;
}): Promise<{ path: string | null }> {
  const includeTokens = options.includeTokens ?? true;
  const includeCosts = options.includeCosts ?? true;
  const messages = options.messages.filter((m) => m.content.trim().length > 0);

  const baseFileName =
    options.baseFileName ??
    `socratic-council-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;

  const format = options.format;
  const extension =
    format === "markdown"
      ? "md"
      : format === "pdf"
        ? "pdf"
        : format === "docx"
          ? "docx"
          : format === "pptx"
            ? "pptx"
            : "json";

  const fileName = `${safeBaseName(baseFileName)}.${extension}`;
  const path = (await pickSavePath(format, fileName)) ?? null;

  const buildOptions = {
    topic: options.topic,
    messages,
    includeTokens,
    includeCosts,
  };

  let data: Uint8Array;
  let mime = "application/octet-stream";

  if (format === "markdown") {
    const text = buildMarkdown(buildOptions);
    data = new TextEncoder().encode(text);
    mime = "text/markdown";
  } else if (format === "json") {
    const text = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        topic: options.topic,
        messages: options.messages,
      },
      null,
      2
    );
    data = new TextEncoder().encode(text + "\n");
    mime = "application/json";
  } else if (format === "pdf") {
    data = await buildPdfBytes(buildOptions);
    mime = "application/pdf";
  } else if (format === "docx") {
    data = await buildDocxBytes(buildOptions);
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else {
    data = await buildPptxBytes({ topic: options.topic, messages });
    mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  if (path) {
    await saveBytes(path, data);
    return { path };
  }

  // Browser/dev fallback: download.
  downloadBytes(fileName, mime, data);
  return { path: null };
}
