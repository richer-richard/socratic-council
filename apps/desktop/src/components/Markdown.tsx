import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";

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

export function Markdown({ content, className, components }: MarkdownProps) {
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
}
