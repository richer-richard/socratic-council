import { useMemo, useState } from "react";
import {
  exportConversation,
  type ConversationExportFormat,
  type ConversationExportMessage,
} from "../services/conversationExport";

const FORMAT_LABELS: Record<ConversationExportFormat, string> = {
  markdown: "Markdown (.md)",
  pdf: "PDF (.pdf)",
  docx: "Word (.docx)",
  pptx: "PowerPoint (.pptx)",
  json: "JSON (.json)",
};

function defaultBaseName() {
  return `socratic-council-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
}

export function ConversationExport({
  topic,
  messages,
  onClose,
}: {
  topic: string;
  messages: ConversationExportMessage[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ConversationExportFormat>("markdown");
  const [includeTokens, setIncludeTokens] = useState(true);
  const [includeCosts, setIncludeCosts] = useState(true);
  const [baseFileName, setBaseFileName] = useState(defaultBaseName);
  const [isExporting, setIsExporting] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const exportCount = useMemo(() => messages.filter((m) => m.content.trim().length > 0).length, [messages]);

  const doExport = async () => {
    setIsExporting(true);
    setLastError(null);
    setLastResult(null);
    try {
      const result = await exportConversation({
        format,
        topic,
        messages,
        includeTokens,
        includeCosts,
        baseFileName,
      });
      setLastResult(result.path ? `Saved: ${result.path}` : "Downloaded");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="scale-in">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]">
          Export
        </h3>
        <button onClick={onClose} className="button-ghost text-xs">
          Close
        </button>
      </div>

      <div className="panel-card p-3 space-y-3">
        <div className="text-xs text-ink-500">
          Export {exportCount} message{exportCount === 1 ? "" : "s"}
        </div>

        <label className="block text-xs text-ink-500">
          Format
          <select
            className="mt-1 w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
            value={format}
            onChange={(e) => setFormat(e.target.value as ConversationExportFormat)}
          >
            {Object.entries(FORMAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-ink-500">
          File name
          <input
            className="mt-1 w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
            value={baseFileName}
            onChange={(e) => setBaseFileName(e.target.value)}
            placeholder="socratic-council-YYYY-MM-DD-HH-MM-SS"
          />
        </label>

        <div className="flex items-center gap-3 text-xs text-ink-700">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeTokens}
              onChange={(e) => setIncludeTokens(e.target.checked)}
            />
            Include tokens
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeCosts}
              onChange={(e) => setIncludeCosts(e.target.checked)}
            />
            Include cost
          </label>
        </div>

        <button
          type="button"
          className="button-primary w-full"
          disabled={isExporting || exportCount === 0}
          onClick={doExport}
        >
          {isExporting ? "Exporting…" : "Export…"}
        </button>

        {lastResult && <div className="text-xs text-emerald-200/90">{lastResult}</div>}
        {lastError && <div className="text-xs text-red-200/90">{lastError}</div>}
      </div>
    </div>
  );
}
