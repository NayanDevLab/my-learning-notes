"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "./theme-provider";

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const { theme } = useTheme();
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          fontFamily: "'Inter', system-ui, sans-serif",
          securityLevel: "loose",
        });
        const { svg: result } = await mermaid.render(
          idRef.current,
          chart
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

    idRef.current = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
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
