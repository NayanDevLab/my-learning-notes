"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { CodeBlock } from "@/components/code-block";
import { Callout, detectCallout } from "@/components/callout";
import { MermaidDiagram } from "@/components/mermaid";
import type { ProcessedCodeBlock } from "@/lib/process-markdown";
import React from "react";

function slugify(text: string): string {
  return text
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/u, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText(
      (children as React.ReactElement<{ children?: React.ReactNode }>).props
        .children
    );
  }
  return "";
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

interface MarkdownBodyProps {
  content: string;
  highlightedBlocks: Record<string, ProcessedCodeBlock>;
}

export function MarkdownBody({ content, highlightedBlocks }: MarkdownBodyProps) {
  const components: Components = {
    h2({ children, ...props }) {
      const text = extractText(children);
      const id = slugify(text);
      return (
        <h2 id={id} {...props} className="heading-anchor">
          {children}
          <a href={`#${id}`} className="anchor-link" aria-hidden="true">#</a>
        </h2>
      );
    },
    h3({ children, ...props }) {
      const text = extractText(children);
      const id = slugify(text);
      return (
        <h3 id={id} {...props} className="heading-anchor">
          {children}
          <a href={`#${id}`} className="anchor-link" aria-hidden="true">#</a>
        </h3>
      );
    },
    pre({ children }) {
      const codeEl = React.Children.toArray(children).find(
        (child): child is React.ReactElement =>
          React.isValidElement(child) && (child as any).type === "code"
      );
      if (!codeEl) return <pre>{children}</pre>;

      const className = (codeEl.props as any).className || "";
      const langMatch = className.match(/language-(\w+)/);
      const lang = langMatch ? langMatch[1] : "";
      const code = extractText((codeEl.props as any).children).replace(
        /\n$/,
        ""
      );

      if (lang === "mermaid") {
        return <MermaidDiagram chart={code} />;
      }

      const isTrace =
        !lang &&
        (code.includes("│") ||
          code.includes("┼") ||
          code.includes("────") ||
          /^\s*(idx|step|k=|i=|j=)\s/im.test(code));

      if (isTrace || lang === "text" || lang === "plaintext") {
        return (
          <div className="trace-block">
            <pre>
              <code>{code}</code>
            </pre>
          </div>
        );
      }

      const key = `${lang}:${hashCode(code)}`;
      const block = highlightedBlocks[key];

      return (
        <CodeBlock
          code={code}
          lang={lang}
          highlighted={block?.highlighted}
          highlightLines={block?.highlightLines}
        />
      );
    },
    blockquote({ children }) {
      const text = extractText(children);
      const config = detectCallout(text);
      if (config) {
        return <Callout config={config}>{children}</Callout>;
      }
      return <blockquote>{children}</blockquote>;
    },
  };

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
