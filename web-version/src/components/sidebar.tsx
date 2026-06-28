"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { NavItem } from "@/lib/content";

function Chevron({ size, open }: { size: number; open: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: "var(--muted)",
        opacity: size < 15 ? 0.8 : 1,
        transition: "transform .18s ease",
        transform: open ? "rotate(0deg)" : "rotate(-90deg)",
      }}
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth={size < 15 ? 2.4 : 2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function buildInitialOpen(
  items: NavItem[],
  currentSlug: string[]
): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  const currentPath = currentSlug.join("/");

  function walk(items: NavItem[]) {
    for (const item of items) {
      if (item.type === "group") {
        const key = item.slug.join("/");
        const containsActive = currentPath.startsWith(key + "/") || currentPath === key;
        open[key] = containsActive;
        walk(item.children);
      }
    }
  }
  walk(items);
  return open;
}

export function Sidebar({
  items,
  currentSlug,
}: {
  items: NavItem[];
  currentSlug: string[];
}) {
  const initialOpen = useMemo(
    () => buildInitialOpen(items, currentSlug),
    [items, currentSlug]
  );
  const [open, setOpen] = useState(initialOpen);

  function toggle(key: string) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <nav
      data-col="sidebar"
      style={{
        width: 280,
        flexShrink: 0,
        background: "var(--sidebar-bg)",
        borderRight: "1px solid var(--border)",
        overflowY: "auto",
        padding: "20px 12px 48px",
      }}
    >
      {items.map((sec) => (
        <SidebarSection
          key={sec.slug.join("/")}
          item={sec}
          currentSlug={currentSlug}
          open={open}
          toggle={toggle}
        />
      ))}
    </nav>
  );
}

function SidebarSection({
  item,
  currentSlug,
  open,
  toggle,
}: {
  item: NavItem;
  currentSlug: string[];
  open: Record<string, boolean>;
  toggle: (key: string) => void;
}) {
  if (item.type === "leaf") {
    const isActive = item.slug.join("/") === currentSlug.join("/");
    return (
      <Link
        href={`/${item.slug.join("/")}`}
        className="nav-leaf"
        data-active={isActive}
      >
        {item.title}
      </Link>
    );
  }

  const key = item.slug.join("/");
  const isOpen = open[key] ?? false;
  const depth = item.slug.length;

  if (depth === 1) {
    return (
      <div style={{ marginBottom: 3 }}>
        <button className="nav-section-btn" onClick={() => toggle(key)}>
          <Chevron size={15} open={isOpen} />
          <span style={{ flex: 1 }}>{item.title}</span>
        </button>
        {isOpen && (
          <div style={{ margin: "1px 0 6px" }}>
            {item.children.map((child) => (
              <SidebarSection
                key={child.slug.join("/")}
                item={child}
                currentSlug={currentSlug}
                open={open}
                toggle={toggle}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <button className="nav-sub-btn" onClick={() => toggle(key)}>
        <Chevron size={13} open={isOpen} />
        <span style={{ flex: 1 }}>{item.title}</span>
      </button>
      {isOpen && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            paddingLeft: 35,
            margin: "1px 0 5px",
          }}
        >
          {item.children.map((child) => (
            <SidebarSection
              key={child.slug.join("/")}
              item={child}
              currentSlug={currentSlug}
              open={open}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
