@AGENTS.md

# NayanDevLab Docs — web-version

Custom documentation site rendering the parent repo's markdown notes with a pixel-perfect design from `design/*.dc.html` exports.

## How to Run

```bash
cd web-version
npm install
npm run dev        # → http://localhost:3000
```

## Project Stack
- **Next.js 16.2.9** (App Router) + React 19.2.4 + TypeScript 5
- **Tailwind CSS v4** via `@tailwindcss/postcss`
- **Shiki** for syntax highlighting (dual-theme: nayan-dark, nayan-light)
- **Mermaid** for diagram rendering (client-side, theme-aware)
- **Fuse.js** for client-side fuzzy search
- **react-markdown** + **remark-gfm** for markdown parsing
- **gray-matter** for frontmatter parsing
- Path alias: `@/*` → `./src/*`

## Architecture

### Content Pipeline
1. `src/lib/content.ts` — reads `.md` files from `../` (parent repo) at build time via `fs`
2. `src/lib/process-markdown.ts` — pre-highlights code blocks server-side with Shiki
3. `src/lib/shiki.ts` — dual Shiki themes matching design tokens
4. `src/app/[...slug]/markdown-body.tsx` — client component rendering markdown with custom components

### Route Structure
- `/` — landing page with section cards
- `/backend/express/event-loop-notes` — note pages (catch-all `[...slug]`)
- `generateStaticParams()` builds all 59 routes at build time

### Component Map
| Component | Type | Purpose |
|-----------|------|---------|
| `theme-provider.tsx` | Client | Dark/light toggle, localStorage persistence |
| `header.tsx` | Server | Brand, search trigger, theme toggle, mobile menu |
| `sidebar.tsx` | Client | Collapsible 3-level nav tree |
| `mobile-sidebar.tsx` | Client | Hamburger drawer on ≤820px |
| `toc.tsx` | Client | "On this page" scroll-spy |
| `search.tsx` | Client | ⌘K modal with Fuse.js fuzzy search |
| `code-block.tsx` | Client | Header bar + copy button + Shiki highlighting |
| `callout.tsx` | Server | Emoji-detected callout boxes (6 types) |
| `mermaid.tsx` | Client | Theme-aware diagram rendering |
| `pagination.tsx` | Server | Previous/Next cards |

## Design Spec (from design/*.dc.html)
- **Fonts:** Inter (body), JetBrains Mono (code) — via next/font/google
- **Theme:** dark default, light via `[data-theme="light"]` on `<html>`
- **Layout:** 3-column — sidebar 280px | main (720px max) | TOC 250px
- **Responsive:** TOC hidden ≤1180px, sidebar hidden ≤820px (hamburger drawer)

### Key CSS Variables
Dark: `--page-bg:#16171a` `--sidebar-bg:#1a1b1e` `--code-bg:#1e1f23` `--text:#e6e6e6` `--accent:#2dd4bf`
Light: `--page-bg:#fafaf8` `--sidebar-bg:#f4f4f1` `--code-bg:#f5f5f2` `--text:#2a2a2a` `--accent:#0d9488`

### Callout Types (emoji → type mapping)
💡→Tip, ⚠️→Warning, ✅→Success, 🎯→Key Point, ⚡→Complexity, 🌶️→Bonus

## Content (parent repo `../`)
- Folders: `backend/`, `databases/`, `dsa/`
- **No frontmatter** — title from first `# heading`
- Filenames: PascalCase-With-Hyphens (`Merge-Sorted-Array-Notes.md`)
- Features: emoji headings, emoji-blockquote callouts, mermaid diagrams, GFM tables, checklists, code blocks, ASCII traces

## Build Notes
- Content lives OUTSIDE web-version/ (in `../`). Read at build time via `path.resolve(process.cwd(), "..")`.
- Next.js 16: `params` is a Promise — must `await params` in page components.
- Check `node_modules/next/dist/docs/` before using new Next.js APIs.
