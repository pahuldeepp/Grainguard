import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Model output is content: never enable raw HTML or external image fetching.
export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        components={{
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h3>{children}</h3>,
          h3: ({ children }) => <h4>{children}</h4>,
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div
              className="assistant-table-scroll"
              role="region"
              aria-label="Answer table"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
