import Markdown, { type Components } from "react-markdown";
import type { ReactNode } from "react";
import remarkGfm from "remark-gfm";

function AnswerHeading({ children }: Readonly<{ children?: ReactNode }>) {
  return <h3>{children}</h3>;
}

function AnswerSubheading({ children }: Readonly<{ children?: ReactNode }>) {
  return <h4>{children}</h4>;
}

function AnswerLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function AnswerTable({ children }: Readonly<{ children?: ReactNode }>) {
  return (
    <div
      className="assistant-table-scroll"
      role="region"
      aria-label="Answer table"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  );
}

const answerComponents: Components = {
  h1: AnswerHeading,
  h2: AnswerHeading,
  h3: AnswerSubheading,
  a: AnswerLink,
  table: AnswerTable,
};

// Model output is content: never enable raw HTML or external image fetching.
export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        components={answerComponents}
      >
        {content}
      </Markdown>
    </div>
  );
}
