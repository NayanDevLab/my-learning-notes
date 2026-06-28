import { createHighlighter, type Highlighter } from "shiki";

const DARK_THEME = {
  name: "nayan-dark",
  type: "dark" as const,
  colors: {
    "editor.background": "#1e1f23",
    "editor.foreground": "#e6e6e6",
  },
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7e8595", fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#9fcb9f" } },
    { scope: ["constant.numeric"], settings: { foreground: "#e0a979" } },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#c99bd6" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#7ab6e6" } },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: "#e3c58a" } },
    { scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: "#e58a92" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#d9a978" } },
    { scope: ["keyword.operator", "punctuation.accessor"], settings: { foreground: "#9aa6ac" } },
    { scope: ["constant.language"], settings: { foreground: "#63bac2" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#aab0b8" } },
    { scope: ["variable", "variable.other"], settings: { foreground: "#e6e6e6" } },
    { scope: ["variable.parameter"], settings: { foreground: "#e6e6e6" } },
    { scope: ["meta.object-literal.key"], settings: { foreground: "#e6e6e6" } },
  ],
};

const LIGHT_THEME = {
  name: "nayan-light",
  type: "light" as const,
  colors: {
    "editor.background": "#f5f5f2",
    "editor.foreground": "#2a2a2a",
  },
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#838991", fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#3f7e3a" } },
    { scope: ["constant.numeric"], settings: { foreground: "#9a6212" } },
    { scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#9333a8" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#2f6bd4" } },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: "#8a5a12" } },
    { scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: "#b5443a" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#9a6212" } },
    { scope: ["keyword.operator", "punctuation.accessor"], settings: { foreground: "#5b636b" } },
    { scope: ["constant.language"], settings: { foreground: "#0a7384" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#5c626a" } },
    { scope: ["variable", "variable.other"], settings: { foreground: "#2a2a2a" } },
    { scope: ["variable.parameter"], settings: { foreground: "#2a2a2a" } },
    { scope: ["meta.object-literal.key"], settings: { foreground: "#2a2a2a" } },
  ],
};

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [DARK_THEME, LIGHT_THEME],
      langs: [
        "javascript",
        "typescript",
        "tsx",
        "jsx",
        "json",
        "bash",
        "shell",
        "sql",
        "css",
        "html",
        "python",
        "markdown",
        "text",
      ],
    });
  }
  return highlighterPromise;
}

export interface HighlightedToken {
  content: string;
  color?: string;
  fontStyle?: string;
}

export interface HighlightedLine {
  tokens: HighlightedToken[];
}

export interface HighlightResult {
  dark: HighlightedLine[];
  light: HighlightedLine[];
}

function mapLang(lang: string): string {
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    node: "javascript",
    sh: "bash",
    zsh: "bash",
    py: "python",
    md: "markdown",
    txt: "text",
    plaintext: "text",
    "": "text",
  };
  return aliases[lang] || lang;
}

export async function highlightCode(
  code: string,
  lang: string
): Promise<HighlightResult> {
  const hl = await getHighlighter();
  const mapped = mapLang(lang);

  const loadedLangs = hl.getLoadedLanguages();
  const actualLang = loadedLangs.includes(mapped as any) ? mapped : "text";

  function extractLines(themeName: string): HighlightedLine[] {
    const result = hl.codeToTokens(code, {
      lang: actualLang as any,
      theme: themeName,
    });
    return result.tokens.map((lineTokens) => ({
      tokens: lineTokens.map((t) => ({
        content: t.content,
        color: t.color || undefined,
        fontStyle: t.fontStyle ? "italic" : undefined,
      })),
    }));
  }

  return {
    dark: extractLines("nayan-dark"),
    light: extractLines("nayan-light"),
  };
}
