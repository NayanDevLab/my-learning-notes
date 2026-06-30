"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "./theme-provider";

const THEME_VARS = {
  dark: {
    primaryColor: "#1e1f23",
    primaryTextColor: "#e6e6e6",
    primaryBorderColor: "#2a2b2f",
    secondaryColor: "#1e1f23",
    secondaryTextColor: "#e6e6e6",
    secondaryBorderColor: "#2a2b2f",
    tertiaryColor: "#1e1f23",
    tertiaryTextColor: "#e6e6e6",
    tertiaryBorderColor: "#2a2b2f",
    lineColor: "#727885",
    textColor: "#e6e6e6",
    mainBkg: "#1e1f23",
    nodeBorder: "#2a2b2f",
    clusterBkg: "#1a1b1e",
    clusterBorder: "#2a2b2f",
    titleColor: "#e6e6e6",
    edgeLabelBackground: "#1e1f23",
    nodeTextColor: "#e6e6e6",
    actorTextColor: "#e6e6e6",
    actorBkg: "#1e1f23",
    actorBorder: "#2a2b2f",
    actorLineColor: "#727885",
    labelBoxBkgColor: "#1e1f23",
    labelBoxBorderColor: "#2a2b2f",
    labelTextColor: "#e6e6e6",
    noteBkgColor: "#232730",
    noteTextColor: "#e6e6e6",
    noteBorderColor: "#2a2b2f",
  },
  light: {
    primaryColor: "#f5f5f2",
    primaryTextColor: "#2a2a2a",
    primaryBorderColor: "#e5e5e0",
    secondaryColor: "#f5f5f2",
    secondaryTextColor: "#2a2a2a",
    secondaryBorderColor: "#e5e5e0",
    tertiaryColor: "#f5f5f2",
    tertiaryTextColor: "#2a2a2a",
    tertiaryBorderColor: "#e5e5e0",
    lineColor: "#a8aca4",
    textColor: "#2a2a2a",
    mainBkg: "#f5f5f2",
    nodeBorder: "#e5e5e0",
    clusterBkg: "#f4f4f1",
    clusterBorder: "#e5e5e0",
    titleColor: "#2a2a2a",
    edgeLabelBackground: "#f5f5f2",
    nodeTextColor: "#2a2a2a",
    actorTextColor: "#2a2a2a",
    actorBkg: "#f5f5f2",
    actorBorder: "#e5e5e0",
    actorLineColor: "#a8aca4",
    labelBoxBkgColor: "#f5f5f2",
    labelBoxBorderColor: "#e5e5e0",
    labelTextColor: "#2a2a2a",
    noteBkgColor: "#eeeee8",
    noteTextColor: "#2a2a2a",
    noteBorderColor: "#e5e5e0",
  },
} as const;

const STYLE_REMAP: Record<string, Record<string, { fill: string; stroke: string }>> = {
  dark: {
    "#d4edda": { fill: "#1a2e22", stroke: "#6cc28a" },
    "#28a745": { fill: "#1a2e22", stroke: "#6cc28a" },
    "#fff3cd": { fill: "#2a2518", stroke: "#d9a55a" },
    "#ffc107": { fill: "#2a2518", stroke: "#d9a55a" },
    "#cce5ff": { fill: "#1a2230", stroke: "#6aa5e0" },
    "#007bff": { fill: "#1a2230", stroke: "#6aa5e0" },
    "#f8d7da": { fill: "#2e1c1e", stroke: "#e8916b" },
    "#dc3545": { fill: "#2e1c1e", stroke: "#e8916b" },
    "#e2d9f3": { fill: "#231e2e", stroke: "#b693dd" },
    "#6f42c1": { fill: "#231e2e", stroke: "#b693dd" },
    "#d1ecf1": { fill: "#172828", stroke: "#3fd0c0" },
    "#17a2b8": { fill: "#172828", stroke: "#3fd0c0" },
  },
  light: {
    "#d4edda": { fill: "#e8f5ed", stroke: "#3f8a52" },
    "#28a745": { fill: "#e8f5ed", stroke: "#3f8a52" },
    "#fff3cd": { fill: "#f5efe0", stroke: "#b5792a" },
    "#ffc107": { fill: "#f5efe0", stroke: "#b5792a" },
    "#cce5ff": { fill: "#e4eef8", stroke: "#2f6bd4" },
    "#007bff": { fill: "#e4eef8", stroke: "#2f6bd4" },
    "#f8d7da": { fill: "#f5e8e6", stroke: "#c2603a" },
    "#dc3545": { fill: "#f5e8e6", stroke: "#c2603a" },
    "#e2d9f3": { fill: "#efe8f5", stroke: "#8a5cc4" },
    "#6f42c1": { fill: "#efe8f5", stroke: "#8a5cc4" },
    "#d1ecf1": { fill: "#e4f2f0", stroke: "#0d9488" },
    "#17a2b8": { fill: "#e4f2f0", stroke: "#0d9488" },
  },
};

function remapStyles(chart: string, theme: "dark" | "light"): string {
  const map = STYLE_REMAP[theme];
  return chart.replace(
    /style\s+(\S+)\s+fill:(#[0-9a-fA-F]{6}),stroke:(#[0-9a-fA-F]{6})/g,
    (_match, nodeId, fill, stroke) => {
      const mapped = map[fill.toLowerCase()] || map[stroke.toLowerCase()];
      if (mapped) {
        return `style ${nodeId} fill:${mapped.fill},stroke:${mapped.stroke},color:${theme === "dark" ? "#e6e6e6" : "#2a2a2a"}`;
      }
      return _match;
    }
  );
}

let idCounter = 0;

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const { theme } = useTheme();
  const idRef = useRef("");

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: THEME_VARS[theme],
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 15,
          securityLevel: "loose",
          flowchart: {
            curve: "basis",
            padding: 20,
            htmlLabels: true,
          },
        });
        const { svg: raw } = await mermaid.render(idRef.current, remapStyles(chart, theme));
        const result = raw.replace(
          /font-size:\s*(\d+(?:\.\d+)?)px/g,
          (_, size) => {
            const scaled = Math.round(parseFloat(size) * 1.35);
            return `font-size:${scaled}px`;
          }
        );
        if (!cancelled) {
          setSvg(result);
          setError("");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Mermaid render failed");
          setSvg("");
        }
      }
    }

    idRef.current = `mermaid-${++idCounter}`;
    render();

    return () => {
      cancelled = true;
    };
  }, [chart, theme]);

  if (error) {
    return (
      <div className="mermaid-error">
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading">Loading diagram…</div>;
  }

  return (
    <figure className="mermaid-figure" ref={containerRef}>
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </figure>
  );
}
