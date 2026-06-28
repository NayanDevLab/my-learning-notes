import { ThemeToggle } from "./theme-toggle";
import { SearchDialog } from "./search";
import { MobileMenuButton } from "./mobile-sidebar";

export function Header() {
  return (
    <header className="site-header">
      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
        <MobileMenuButton />
        <a
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            textDecoration: "none",
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
        </a>
      </div>

      {/* Search */}
      <SearchDialog />

      {/* Theme toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
        <ThemeToggle />
      </div>
    </header>
  );
}
