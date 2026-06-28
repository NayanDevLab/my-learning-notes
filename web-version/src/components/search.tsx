"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Fuse from "fuse.js";
import { useRouter } from "next/navigation";
import type { SearchEntry } from "@/lib/content";

export function SearchDialog({ entries }: { entries: SearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const router = useRouter();

  const fuse = useMemo(
    () =>
      new Fuse(entries, {
        keys: [
          { name: "title", weight: 2 },
          { name: "snippet", weight: 1 },
          { name: "section", weight: 0.5 },
        ],
        threshold: 0.35,
        includeMatches: true,
      }),
    [entries]
  );

  const results = useMemo(() => {
    if (!query.trim()) return entries.slice(0, 8);
    return fuse.search(query, { limit: 12 }).map((r) => r.item);
  }, [fuse, query, entries]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [results]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const navigate = useCallback(
    (slug: string) => {
      setOpen(false);
      setQuery("");
      router.push(slug);
    },
    [router]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[selectedIdx]) {
        navigate(results[selectedIdx].slug);
      }
    },
    [results, selectedIdx, navigate]
  );

  return (
    <>
      {/* Trigger button in header */}
      <button
        onClick={() => setOpen(true)}
        className="search-trigger"
        type="button"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--muted)" }}
        >
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="search-trigger-text">Search notes…</span>
        <kbd className="search-kbd">⌘K</kbd>
      </button>

      {/* Modal overlay */}
      {open && (
        <div className="search-overlay" onClick={() => { setOpen(false); setQuery(""); }}>
          <div className="search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="search-input-row">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                style={{ flexShrink: 0, color: "var(--muted)" }}
              >
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search all notes…"
                className="search-input"
              />
              <kbd className="search-kbd" onClick={() => { setOpen(false); setQuery(""); }}>
                Esc
              </kbd>
            </div>
            <div className="search-results">
              {results.length === 0 && query.trim() && (
                <div className="search-empty">No results for &ldquo;{query}&rdquo;</div>
              )}
              {results.map((entry, i) => (
                <button
                  key={entry.slug}
                  className="search-result"
                  data-selected={i === selectedIdx}
                  onClick={() => navigate(entry.slug)}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  <div className="search-result-title">{entry.title}</div>
                  <div className="search-result-section">{entry.section}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
