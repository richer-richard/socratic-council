import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

interface MarkdownProps {
  content: string;
  className?: string;
  /**
   * Additional ReactMarkdown component overrides. Merged on top of the
   * default `a` anchor override. Callers that need fully custom anchor
   * handling (e.g. citation buttons) can pass their own `a` here.
   */
  components?: Components;
}

const defaultAnchor: Components["a"] = ({ href, children, ...props }) => {
  const safeHref = typeof href === "string" ? href : undefined;
  return (
    <a href={safeHref} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  );
};

// Memoized: the markdown → remark/rehype/KaTeX/highlight.js pipeline is the most
// expensive thing on the transcript render path, and it re-runs for EVERY visible
// row on each ~50ms streaming flush. A shallow prop compare lets every row whose
// `content` didn't change skip the re-parse entirely (callers that pass an inline
// `components` object should memoize it so this compare stays effective).
export const Markdown = memo(function Markdown({ content, className, components }: MarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { ignoreMissing: true }]]}
        components={{ a: defaultAnchor, ...components }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
