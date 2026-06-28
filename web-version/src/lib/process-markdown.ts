import { highlightCode, type HighlightResult } from "./shiki";

export interface ProcessedCodeBlock {
  code: string;
  lang: string;
  highlighted: HighlightResult;
  highlightLines: number[];
}

function parseLineSpec(meta: string): number[] {
  const match = meta.match(/\{([^}]+)\}/);
  if (!match) return [];
  const lines: number[] = [];
  for (const part of match[1].split(",")) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      for (let i = start; i <= end; i++) lines.push(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n)) lines.push(n);
    }
  }
  return lines;
}

export async function preHighlightCodeBlocks(
  markdown: string
): Promise<Map<string, ProcessedCodeBlock>> {
  const codeBlockRegex = /```(\w*)(?: *(\{[^}]*\}))?\n([\s\S]*?)```/g;
  const blocks = new Map<string, ProcessedCodeBlock>();
  const promises: Promise<void>[] = [];

  let match;
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const lang = match[1] || "";
    const meta = match[2] || "";
    const code = match[3].replace(/\n$/, "");

    if (lang === "mermaid") continue;

    const key = `${lang}:${hashCode(code)}`;
    if (blocks.has(key)) continue;

    const highlightLines = parseLineSpec(meta);

    promises.push(
      highlightCode(code, lang).then((highlighted) => {
        blocks.set(key, { code, lang, highlighted, highlightLines });
      })
    );
  }

  await Promise.all(promises);
  return blocks;
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

export function codeBlockKey(lang: string, code: string): string {
  return `${lang}:${hashCode(code)}`;
}
