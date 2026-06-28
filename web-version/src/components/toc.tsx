"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export function TableOfContents({ headings }: { headings: TocHeading[] }) {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? "");
  const rafRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const main = document.querySelector('[data-col="main"]');
      if (!main) return;

      const top0 = main.getBoundingClientRect().top;
      const hEls = main.querySelectorAll("h2[id], h3[id]");
      if (!hEls.length) return;

      let active = (hEls[0] as HTMLElement).id;
      for (const h of hEls) {
        if (h.getBoundingClientRect().top - top0 <= 120) {
          active = h.id;
        } else {
          break;
        }
      }

      if (
        main.scrollTop + main.clientHeight >=
        main.scrollHeight - 4
      ) {
        active = (hEls[hEls.length - 1] as HTMLElement).id;
      }

      setActiveId(active);
    });
  }, []);

  useEffect(() => {
    const main = document.querySelector('[data-col="main"]');
    if (!main) return;
    main.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      main.removeEventListener("scroll", handleScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handleScroll]);

  function scrollTo(id: string) {
    const main = document.querySelector('[data-col="main"]');
    if (!main) return;
    const el = main.querySelector(`#${CSS.escape(id)}`);
    if (!el) return;
    const top0 = main.getBoundingClientRect().top;
    const ht = el.getBoundingClientRect().top;
    main.scrollTo({
      top: main.scrollTop + (ht - top0) - 28,
      behavior: "smooth",
    });
  }

  if (headings.length === 0) return null;

  return (
    <aside
      data-col="toc"
      style={{
        width: 250,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        overflowY: "auto",
        padding: "28px 22px 48px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--muted)",
          margin: "0 0 14px",
        }}
      >
        On this page
      </div>
      <div style={{ borderLeft: "1px solid var(--border)" }}>
        {headings.map((h) => (
          <button
            key={h.id}
            className="toc-item"
            data-active={h.id === activeId}
            data-level={h.level}
            onClick={() => scrollTo(h.id)}
            style={{
              background: "none",
              border: "none",
              fontFamily: "inherit",
              textAlign: "left",
              width: "100%",
            }}
          >
            {h.text}
          </button>
        ))}
      </div>
    </aside>
  );
}
