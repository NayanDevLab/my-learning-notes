"use client";

import { useState, useCallback } from "react";
import type { HighlightResult } from "@/lib/shiki";

interface CodeBlockProps {
  code: string;
  lang: string;
  label?: string;
  highlighted?: HighlightResult;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: "var(--accent)" }}>
      <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CodeBlock({ code, lang, label, highlighted }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const displayLabel = label || inferLabel(lang);
  const displayLang = lang || "";

  return (
    <div className="code-block">
      {/* Header bar */}
      <div className="code-block-header">
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span className="code-block-dot" />
          <span className="code-block-label">{displayLabel}</span>
          {displayLang && <span className="code-block-lang">{displayLang}</span>}
        </div>
        <button
          onClick={onCopy}
          aria-label="Copy code"
          className="code-block-copy"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Code body */}
      <div className="code-block-scroll">
        <div className="code-block-body">
          {highlighted ? (
            <HighlightedCode highlighted={highlighted} />
          ) : (
            <pre style={{ margin: 0, background: "transparent", border: "none", padding: 0 }}>
              <code>{code}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function HighlightedCode({ highlighted }: { highlighted: HighlightResult }) {
  return (
    <>
      <div className="code-lines" data-theme-target="dark">
        {highlighted.dark.map((line, i) => (
          <div key={i} className="code-line">
            <span className="code-gutter">{i + 1}</span>
            <span className="code-content">
              {line.tokens.map((tok, j) => (
                <span key={j} style={{ color: tok.color, fontStyle: tok.fontStyle }}>
                  {tok.content}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="code-lines" data-theme-target="light">
        {highlighted.light.map((line, i) => (
          <div key={i} className="code-line">
            <span className="code-gutter">{i + 1}</span>
            <span className="code-content">
              {line.tokens.map((tok, j) => (
                <span key={j} style={{ color: tok.color, fontStyle: tok.fontStyle }}>
                  {tok.content}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function inferLabel(lang: string): string {
  const labels: Record<string, string> = {
    javascript: "script.js",
    js: "script.js",
    typescript: "script.ts",
    ts: "script.ts",
    tsx: "component.tsx",
    jsx: "component.jsx",
    bash: "terminal",
    sh: "terminal",
    shell: "terminal",
    sql: "query.sql",
    json: "data.json",
    css: "styles.css",
    html: "index.html",
    python: "script.py",
    py: "script.py",
    node: "server.js",
    text: "output",
    "": "code",
    mermaid: "diagram",
  };
  return labels[lang] || `file.${lang}`;
}
