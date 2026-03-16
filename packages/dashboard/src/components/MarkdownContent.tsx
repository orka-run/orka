import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github.css";

interface MarkdownContentProps {
  content: string;
}

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  node?: {
    tagName?: string;
    properties?: {
      className?: string[] | string;
    };
  };
};

function getClassName(value: string[] | string | undefined): string {
  if (Array.isArray(value)) {
    return value.join(" ");
  }

  return value ?? "";
}

function MarkdownCode({ className, children, node, ...props }: CodeProps) {
  const nodeClassName = getClassName(node?.properties?.className);
  const combinedClassName = [className, nodeClassName].filter(Boolean).join(" ").trim();
  const isBlock = node?.tagName === "code" && (combinedClassName.length > 0 || String(children).includes("\n"));

  if (isBlock) {
    return (
      <code
        className={[
          "block min-w-full bg-transparent p-0 font-mono text-[12px] leading-6 text-ink",
          combinedClassName,
        ].filter(Boolean).join(" ")}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <code
      className="rounded-sm border border-border bg-surface-alt px-1 py-0.5 font-mono text-[0.9em] text-ink"
      {...props}
    >
      {children}
    </code>
  );
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="min-w-0 max-w-none text-[12px] leading-6 text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ children }) => <h1 className="mt-4 text-[16px] font-semibold tracking-tight text-ink first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 text-[14px] font-semibold tracking-tight text-ink first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 text-[13px] font-semibold text-ink first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-secondary first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
          ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 marker:text-ink-muted">{children}</ul>,
          ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5 marker:text-ink-muted">{children}</ol>,
          li: ({ children }) => <li className="pl-1 text-ink-secondary">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent-strong underline decoration-accent/40 underline-offset-4 transition hover:text-accent hover:decoration-accent/80"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mt-3 border-l-2 border-border pl-3 italic text-ink-secondary">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
          table: ({ children }) => (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-[12px] text-ink-secondary">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-border text-ink">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
          th: ({ children }) => <th className="px-2 py-1.5 font-medium">{children}</th>,
          td: ({ children }) => <td className="px-2 py-1.5 align-top text-ink-secondary">{children}</td>,
          img: (props) => (
            // eslint-disable-next-line jsx-a11y/alt-text
            <img className="max-w-full h-auto" {...props} />
          ),
          pre: ({ children }) => (
            <pre className="mt-3 overflow-x-auto rounded-sm border border-border bg-surface-alt px-2 py-2 text-[12px] leading-6 [-webkit-overflow-scrolling:touch] md:whitespace-pre-wrap md:break-all md:[overflow-wrap:anywhere]">
              {children}
            </pre>
          ),
          code: MarkdownCode as never,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
