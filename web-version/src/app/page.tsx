import { getNavTree, getAllSlugs } from "@/lib/content";
import type { NavItem } from "@/lib/content";
import { Header } from "@/components/header";
import Link from "next/link";

const SECTION_ICONS: Record<string, string> = {
  backend: "🔧",
  databases: "🗄️",
  dsa: "🧮",
  sql: "📊",
  "system-design": "🏗️",
};

function countLeaves(item: NavItem): number {
  if (item.type === "leaf") return 1;
  return item.children.reduce((n, c) => n + countLeaves(c), 0);
}

function firstLeaf(items: NavItem[]): string | null {
  for (const item of items) {
    if (item.type === "leaf") return "/" + item.slug.join("/");
    const found = firstLeaf(item.children);
    if (found) return found;
  }
  return null;
}

export default function Home() {
  const tree = getNavTree();
  const totalNotes = getAllSlugs().length;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--page-bg)",
        color: "var(--text)",
        overflow: "hidden",
      }}
    >
      <Header />

      <main style={{ flex: 1, overflowY: "auto", padding: "0 24px" }}>
        <div
          style={{
            maxWidth: 760,
            margin: "0 auto",
            padding: "64px 0 120px",
          }}
        >
          <div style={{ marginBottom: 48 }}>
            <h1
              style={{
                fontSize: 42,
                fontWeight: 700,
                letterSpacing: "-0.025em",
                lineHeight: 1.15,
                margin: "0 0 16px",
              }}
            >
              NayanDevLab Notes
            </h1>
            <p
              style={{
                fontSize: 18,
                lineHeight: 1.65,
                color: "var(--muted)",
                maxWidth: 540,
                margin: 0,
              }}
            >
              Personal learning notes on backend engineering, databases, data
              structures & algorithms, and system design — written for deep
              understanding and interview prep.
            </p>
          </div>

          <div className="landing-grid">
            {tree.map((section) => {
              const href = firstLeaf(
                section.type === "group" ? section.children : [section]
              );
              const count = countLeaves(section);
              const icon = SECTION_ICONS[section.slug[0]] || "📝";
              const subs =
                section.type === "group"
                  ? section.children
                      .filter((c) => c.type === "group")
                      .map((c) => c.title)
                      .slice(0, 4)
                  : [];

              return (
                <Link
                  key={section.slug.join("/")}
                  href={href || "/"}
                  className="landing-card"
                >
                  <div className="landing-card-icon">{icon}</div>
                  <div>
                    <h2 className="landing-card-title">{section.title}</h2>
                    <p className="landing-card-count">
                      {count} {count === 1 ? "note" : "notes"}
                    </p>
                    {subs.length > 0 && (
                      <p className="landing-card-subs">{subs.join(" · ")}</p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 48,
              padding: "20px 0",
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 32,
              color: "var(--muted)",
              fontSize: 14,
            }}
          >
            <span>
              <strong style={{ color: "var(--text)" }}>{totalNotes}</strong>{" "}
              notes
            </span>
            <span>
              <strong style={{ color: "var(--text)" }}>{tree.length}</strong>{" "}
              sections
            </span>
            <span>
              Press{" "}
              <kbd
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  background: "var(--code-bg)",
                }}
              >
                ⌘K
              </kbd>{" "}
              to search
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
