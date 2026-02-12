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

function buildPlainText(options: {
  topic: string;
  messages: ConversationExportMessage[];
  includeTokens: boolean;
  includeCosts: boolean;
}) {
  const lines: string[] = [];
  lines.push("Socratic Council Transcript");
  lines.push("");
  lines.push(`Topic: ${options.topic}`);
  lines.push(`Exported: ${new Date().toLocaleString()}`);
  lines.push("");
  lines.push("------------------------------------------------------------");
  lines.push("");

  for (const msg of options.messages) {
    const headerParts = [`${msg.speaker}`, formatTime(msg.timestamp)];
    if (msg.model) headerParts.splice(1, 0, `(${msg.model})`);
    lines.push(headerParts.join(" · "));
    if (options.includeTokens && msg.tokens) {
      const tokensLine = `${msg.tokens.input}/${msg.tokens.output} tokens`;
      const costLine =
        options.includeCosts && msg.costUSD != null ? ` · $${msg.costUSD.toFixed(4)}` : "";
      lines.push(`${tokensLine}${costLine}`);
    } else if (options.includeCosts && msg.costUSD != null) {
      lines.push(`$${msg.costUSD.toFixed(4)}`);
    }
    lines.push("");
    lines.push(msg.content.trim());
    lines.push("");
    lines.push("------------------------------------------------------------");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

async function buildPdfBytes(text: string): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });

  const margin = 54;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  let y = margin;
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  for (const line of lines) {
    if (y > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(line, margin, y);
    y += 14;
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
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = docx;

  const paragraphs: unknown[] = [];
  paragraphs.push(
    new Paragraph({
      text: "Socratic Council Transcript",
      heading: HeadingLevel.TITLE,
    })
  );
  paragraphs.push(new Paragraph({ text: `Topic: ${options.topic}` }));
  paragraphs.push(new Paragraph({ text: `Exported: ${new Date().toLocaleString()}` }));
  paragraphs.push(new Paragraph({ text: "" }));

  for (const msg of options.messages) {
    const header = `${msg.speaker}${msg.model ? ` (${msg.model})` : ""} · ${formatTime(msg.timestamp)}`;
    paragraphs.push(new Paragraph({ text: header, heading: HeadingLevel.HEADING_3 }));

    if (options.includeTokens && msg.tokens) {
      const tokensLine = `${msg.tokens.input}/${msg.tokens.output} tokens`;
      const costLine =
        options.includeCosts && msg.costUSD != null ? ` · $${msg.costUSD.toFixed(4)}` : "";
      paragraphs.push(new Paragraph({ text: `${tokensLine}${costLine}` }));
    } else if (options.includeCosts && msg.costUSD != null) {
      paragraphs.push(new Paragraph({ text: `$${msg.costUSD.toFixed(4)}` }));
    }

    const contentLines = msg.content.trim().split("\n");
    const runs = contentLines.flatMap((line, idx) => {
      const run = new TextRun({ text: line });
      return idx === 0 ? [run] : [new TextRun({ text: line, break: 1 })];
    });
    paragraphs.push(new Paragraph({ children: runs.length > 0 ? runs : [new TextRun({ text: "" })] }));

    paragraphs.push(new Paragraph({ text: "" }));
  }

  const document = new Document({
    sections: [
      {
        properties: {},
        children: paragraphs as any,
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
  const mod = await import("pptxgenjs");
  const PptxGen = (mod as any).default ?? mod;
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Socratic Council";
  pptx.title = "Socratic Council Transcript";
  pptx.subject = options.topic;

  const bg = "0B0F14";
  const fg = "F8FAFC";
  const muted = "9AA6BD";

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: bg };
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
    slide.addText(`Transcript (${i + 1}–${Math.min(i + perSlide, entries.length)})`, {
      x: 0.6,
      y: 0.4,
      w: 12.1,
      h: 0.4,
      fontSize: 18,
      color: muted,
      bold: true,
    });
    slide.addText(chunk.join("\n\n"), {
      x: 0.6,
      y: 1.0,
      w: 12.1,
      h: 6.0,
      fontSize: 14,
      color: fg,
      valign: "top",
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
    messages: options.messages,
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
    const text = buildPlainText(buildOptions);
    data = await buildPdfBytes(text);
    mime = "application/pdf";
  } else if (format === "docx") {
    data = await buildDocxBytes(buildOptions);
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else {
    data = await buildPptxBytes({ topic: options.topic, messages: options.messages });
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
