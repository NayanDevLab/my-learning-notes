import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header
      style={{
        display: "grid",
        gridTemplateColumns: "1fr minmax(0,460px) 1fr",
        alignItems: "center",
        gap: 24,
        height: 60,
        padding: "0 22px",
        background: "var(--sidebar-bg)",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      {/* Brand */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          minWidth: 0,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#0a1f1c",
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 800,
            fontSize: 15,
            flexShrink: 0,
          }}
        >
          N
        </div>
        <span
          style={{
            fontWeight: 700,
            fontSize: 15.5,
            letterSpacing: "-0.01em",
            color: "var(--text)",
            whiteSpace: "nowrap",
          }}
        >
          NayanDevLab
        </span>
      </div>

      {/* Search (UI only) */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          height: 38,
          padding: "0 12px",
          borderRadius: 10,
          background: "var(--code-bg)",
          border: "1px solid var(--border)",
          minWidth: 0,
        }}
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
          <path
            d="M21 21l-4.3-4.3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <input
          placeholder="Search notes…"
          readOnly
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            background: "transparent",
            outline: "none",
            color: "var(--text)",
            fontFamily: "inherit",
            fontSize: 14,
          }}
        />
        <kbd
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 11,
            color: "var(--muted)",
            background: "var(--page-bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "2px 6px",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ⌘K
        </kbd>
      </label>

      {/* Theme toggle */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <ThemeToggle />
      </div>
    </header>
  );
}
