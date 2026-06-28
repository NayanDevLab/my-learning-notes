import { highlightCode, type HighlightResult } from "./shiki";

export interface ProcessedCodeBlock {
  code: string;
  lang: string;
  highlighted: HighlightResult;
}

export async function preHighlightCodeBlocks(
  markdown: string
): Promise<Map<string, ProcessedCodeBlock>> {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const blocks = new Map<string, ProcessedCodeBlock>();
  const promises: Promise<void>[] = [];

  let match;
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const lang = match[1] || "";
    const code = match[2].replace(/\n$/, "");

    if (lang === "mermaid") continue;

    const key = `${lang}:${hashCode(code)}`;
    if (blocks.has(key)) continue;

    promises.push(
      highlightCode(code, lang).then((highlighted) => {
        blocks.set(key, { code, lang, highlighted });
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
