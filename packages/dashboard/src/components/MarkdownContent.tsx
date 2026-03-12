import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

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
          "block min-w-full bg-transparent p-0 font-mono text-[13px] leading-6 text-zinc-100",
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
      className="rounded-md border border-zinc-700/80 bg-zinc-800/90 px-1.5 py-0.5 font-mono text-[0.9em] text-zinc-100"
      {...props}
    >
      {children}
    </code>
  );
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="max-w-none text-sm leading-6 text-zinc-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ children }) => <h1 className="mt-6 text-xl font-semibold tracking-tight text-zinc-50 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-6 text-lg font-semibold tracking-tight text-zinc-50 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-5 text-base font-semibold text-zinc-100 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.12em] text-zinc-300 first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="mt-3 first:mt-0">{children}</p>,
          ul: ({ children }) => <ul className="mt-3 list-disc space-y-2 pl-6 marker:text-zinc-500">{children}</ul>,
          ol: ({ children }) => <ol className="mt-3 list-decimal space-y-2 pl-6 marker:text-zinc-500">{children}</ol>,
          li: ({ children }) => <li className="pl-1 text-zinc-200">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-sky-300 underline decoration-sky-400/40 underline-offset-4 transition hover:text-sky-200 hover:decoration-sky-300/80"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mt-4 border-l-2 border-zinc-700 pl-4 italic text-zinc-300">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-5 border-zinc-800" />,
          table: ({ children }) => (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-sm text-zinc-200">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-zinc-700 text-zinc-100">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-zinc-800">{children}</tbody>,
          th: ({ children }) => <th className="px-3 py-2 font-medium">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top text-zinc-300">{children}</td>,
          pre: ({ children }) => (
            <pre className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13px] leading-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
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
