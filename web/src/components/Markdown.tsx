import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders markdown with raw HTML dropped (no rehype-raw), so prompts can't inject markup. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
