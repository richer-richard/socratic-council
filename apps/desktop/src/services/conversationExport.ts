import type { FileChild } from "docx";

export type ConversationExportFormat = "markdown" | "pdf" | "docx" | "pptx" | "json";

export type ConversationExportMessage = {
  id: string;
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

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
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
  doc.setFontSize(26);
  doc.text("Socratic Council Transcript", titleX, 58);

  doc.setFontSize(12);
  doc.setTextColor(headerFg.r, headerFg.g, headerFg.b);
  doc.text(`Topic: ${safeTopic}`, titleX, 82, { maxWidth: pageWidth - titleX - margin });
  doc.setTextColor(headerFg.r, headerFg.g, headerFg.b);
  doc.text(`Exported: ${exportedAt.toLocaleString()}`, titleX, 102);

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
  const chartH = 150;

  doc.setFillColor(cardBg.r, cardBg.g, cardBg.b);
  doc.setDrawColor(cardBorder.r, cardBorder.g, cardBorder.b);
  pdfRoundedRect(doc, chartX, chartY, chartW, chartH, 10, "DF");

  doc.setTextColor(muted.r, muted.g, muted.b);
  doc.setFontSize(11);
  doc.text("Messages by Speaker", chartX + 14, chartY + 22);

  const barMax = Math.max(1, ...stats.speakers.map((s) => s.messageCount));
  const barAreaX = chartX + 14;
  const barAreaY = chartY + 38;
  const barAreaW = chartW - 28;
  const barAreaH = chartH - 56;

  const rowH = Math.max(14, barAreaH / Math.max(1, stats.speakers.length));
  doc.setFontSize(10);
  for (let i = 0; i < stats.speakers.length; i += 1) {
    const s = stats.speakers[i];
    const rowY = barAreaY + i * rowH;
    const label = s.speaker.length > 18 ? `${s.speaker.slice(0, 17)}…` : s.speaker;

    const barLabelW = 120;
    const barX = barAreaX + barLabelW;
    const barW = Math.max(0, barAreaW - barLabelW - 40);
    const valueW = (s.messageCount / barMax) * barW;

    const accent = hexToRgb(colorForSpeaker(s.speaker));
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(label, barAreaX, rowY + 10);

    doc.setFillColor(cardBorder.r, cardBorder.g, cardBorder.b);
    doc.rect(barX, rowY + 2, barW, 10, "F");

    doc.setFillColor(accent.r, accent.g, accent.b);
    doc.rect(barX, rowY + 2, valueW, 10, "F");

    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(String(s.messageCount), barX + barW + 10, rowY + 10);
  }

  if (options.includeCosts && stats.totalCostUSD > 0) {
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(10);
    doc.text(`Total cost: ${formatUsd(stats.totalCostUSD)}`, chartX + 14, chartY + chartH - 14);
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
