/**
 * Selection drawn behind the selected text only.
 *
 * WebKit, which draws the app, fills the gaps of a selection: past the end of
 * every selected line and across the space between selected blocks, out to
 * the edge of the nearest block that paints its own selection. On a padded
 * card that is the card's edge, well past the text. So the native highlight
 * is made transparent (see `.sc-text-selection` in globals.css) and the
 * selected ranges are painted through the CSS Custom Highlight API instead,
 * which only ever paints behind text. Inputs and textareas keep the native
 * highlight: a range cannot reach their text, and they clip to their box.
 */
export const SELECTION_CLASS = "sc-text-selection";
const NAME = "sc-selection";

type WithHighlights = Window & {
  CSS?: { highlights?: HighlightRegistry };
  Highlight?: typeof Highlight;
};

export function installSelectionHighlight(win: Window = window): () => void {
  const registry = (win as WithHighlights).CSS?.highlights;
  const HighlightCtor = (win as WithHighlights).Highlight;
  // Without the API the native highlight stays, gaps and all.
  if (!registry || typeof HighlightCtor !== "function") return () => undefined;

  const doc = win.document;
  const highlight = new HighlightCtor();
  registry.set(NAME, highlight);
  doc.documentElement.classList.add(SELECTION_CLASS);

  const update = () => {
    highlight.clear();
    const selection = doc.getSelection();
    if (!selection) return;
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      if (!range.collapsed) highlight.add(range.cloneRange());
    }
  };
  doc.addEventListener("selectionchange", update);

  return () => {
    doc.removeEventListener("selectionchange", update);
    registry.delete(NAME);
    doc.documentElement.classList.remove(SELECTION_CLASS);
  };
}
