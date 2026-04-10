import type { CanvasState } from "../utils/canvasActions";

interface AgentCanvasProps {
  canvas: CanvasState;
  agentColor: string;
  isStreaming: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export function AgentCanvas({ canvas, agentColor, isStreaming, isExpanded, onToggleExpand }: AgentCanvasProps) {
  if (canvas.sections.length === 0) return null;

  const classNames = [
    "agent-canvas",
    isStreaming ? "is-streaming" : "",
    !isExpanded ? "is-collapsed" : "",
    !isStreaming && isExpanded ? "is-faded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classNames}
      style={{ "--canvas-accent": agentColor } as React.CSSProperties}
    >
      <button type="button" className="canvas-header" onClick={onToggleExpand}>
        <span className="canvas-header-label">Canvas</span>
        <span className="canvas-header-count">{canvas.sections.length}</span>
        <span className="canvas-header-toggle">{isExpanded ? "−" : "+"}</span>
      </button>

      {isExpanded && (
        <div className="canvas-body">
          {canvas.sections.map((section) => (
            <div key={section.id} className="canvas-section">
              <div className="canvas-section-label">{section.label}</div>
              <div className="canvas-section-text">{section.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
