import type { ReactFlowInstance } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";

import type { PanelView } from "./types";

/**
 * Snapshot the active panel surface as an SVG/PNG. For the Graph view
 * we briefly fitView() so the export captures the entire layout, not
 * just whatever the user has panned/zoomed into; the previous viewport
 * is restored after the snapshot resolves.
 *
 * For non-Graph views we fall back to capturing the panel's content
 * region. This still gives a usable export for the Outline / Stance /
 * Timeline tabs even though they're not the natural target of an SVG.
 */

const HTML_TO_IMAGE_OPTIONS = {
  cacheBust: true,
  backgroundColor: "rgb(8, 7, 12)",
  pixelRatio: 2,
  filter: (node: HTMLElement) => {
    // Skip the react-flow controls/minimap so the export stays clean.
    if (node.classList?.contains?.("react-flow__controls")) return false;
    if (node.classList?.contains?.("react-flow__minimap")) return false;
    if (node.classList?.contains?.("react-flow__attribution")) return false;
    return true;
  },
};

function findCaptureNode(view: PanelView): HTMLElement | null {
  if (view === "graph") {
    const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (vp) return vp;
  }
  // Fall back to the panel content region.
  const aside = document.querySelector<HTMLElement>('aside[aria-label="Argument map"]');
  return aside;
}

async function withFitView<T>(
  flow: ReactFlowInstance | null,
  view: PanelView,
  fn: () => Promise<T>,
): Promise<T> {
  if (!flow || view !== "graph") return fn();
  const previous = flow.getViewport();
  try {
    flow.fitView({ padding: 0.2, duration: 0 });
    // Give the renderer one frame to apply the new transform.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return await fn();
  } finally {
    flow.setViewport(previous, { duration: 0 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function exportArgGraphSvg(flow: any, view: PanelView): Promise<string> {
  return withFitView(flow as ReactFlowInstance | null, view, async () => {
    const node = findCaptureNode(view);
    if (!node) throw new Error("Argument map node not found");
    const dataUrl = await toSvg(node, HTML_TO_IMAGE_OPTIONS);
    // toSvg returns a data:image/svg+xml;charset=utf-8,<encoded> URL — strip
    // the prefix so we can save raw SVG text.
    if (dataUrl.startsWith("data:image/svg+xml")) {
      const commaIdx = dataUrl.indexOf(",");
      if (commaIdx > -1) {
        const payload = dataUrl.slice(commaIdx + 1);
        try {
          return decodeURIComponent(payload);
        } catch {
          return atob(payload);
        }
      }
    }
    return dataUrl;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function exportArgGraphPng(flow: any, view: PanelView): Promise<Blob> {
  return withFitView(flow as ReactFlowInstance | null, view, async () => {
    const node = findCaptureNode(view);
    if (!node) throw new Error("Argument map node not found");
    const dataUrl = await toPng(node, HTML_TO_IMAGE_OPTIONS);
    const res = await fetch(dataUrl);
    return res.blob();
  });
}
