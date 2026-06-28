"use client";

import { useState } from "react";
import type { NavItem } from "@/lib/content";
import { Sidebar } from "./sidebar";

export function MobileMenuButton() {
  return (
    <button
      className="mobile-menu-btn"
      onClick={() => {
        document.body.classList.toggle("mobile-sidebar-open");
      }}
      aria-label="Toggle navigation"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
}

export function MobileSidebarOverlay({
  items,
  currentSlug,
}: {
  items: NavItem[];
  currentSlug: string[];
}) {
  return (
    <>
      <div
        className="mobile-sidebar-backdrop"
        onClick={() => document.body.classList.remove("mobile-sidebar-open")}
      />
      <div className="mobile-sidebar-drawer">
        <Sidebar items={items} currentSlug={currentSlug} />
      </div>
    </>
  );
}
