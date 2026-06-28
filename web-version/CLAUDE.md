@AGENTS.md

# NayanDevLab Docs — web-version

Custom documentation site rendering the parent repo's markdown notes with a pixel-perfect design from `design/*.dc.html` exports.

## Project Stack
- **Next.js 16.2.9** (App Router) + React 19.2.4 + TypeScript 5
- **Tailwind CSS v4** via `@tailwindcss/postcss` with `@import "tailwindcss"` syntax
- Path alias: `@/*` → `./src/*`
- ESLint 9 flat config

## Design Spec (from design/*.dc.html)
- **Fonts:** Inter (body, 400–700), JetBrains Mono (code, 400–600) — both via Google Fonts
- **Theme:** dark default, light via `[data-theme="light"]` attribute on root
- **Layout:** 3-column — sidebar 280px | main (720px max article) | TOC 250px
- **Header:** 60px, logo + search + theme toggle
- **Responsive:** TOC hidden ≤1180px, sidebar hidden ≤820px
- **Reading size:** 17px default (range 16–19px)

### Key CSS Variables
Dark: `--page-bg:#16171a` `--sidebar-bg:#1a1b1e` `--code-bg:#1e1f23` `--text:#e6e6e6` `--muted:#9ca3af` `--border:#2a2b2f` `--accent:#2dd4bf` `--accent-soft:rgba(45,212,191,.13)`
Light: `--page-bg:#fafaf8` `--sidebar-bg:#f4f4f1` `--code-bg:#f5f5f2` `--text:#2a2a2a` `--muted:#6b7280` `--border:#e5e5e0` `--accent:#0d9488` `--accent-soft:rgba(13,148,136,.10)`

### Callout Types (emoji → type mapping)
- 💡 → Tip (blue `--cal-tip`)
- ⚠️ → Warning (amber `--cal-warn`)
- ✅ → Success (green `--cal-ok`)
- 🎯 → Key Point (purple `--cal-goal`)
- ⚡ → Complexity/Note (teal `--cal-note`)
- 🌶️ → Bonus (orange `--cal-bonus`)

### Syntax Highlighting Tokens
`--hl-kw` (keywords), `--hl-str` (strings), `--hl-num` (numbers), `--hl-com` (comments), `--hl-fn` (functions), `--hl-type` (types), `--hl-tag` (JSX tags), `--hl-attr` (attributes), `--hl-op` (operators), `--hl-bool` (booleans), `--hl-punc` (punctuation)

## Content (parent repo `../`)
- Folders: `backend/`, `databases/`, `dsa/`, `sql/`, `system-design/`, `templates/`
- **No frontmatter** — title from first `# heading`
- Filenames: PascalCase-With-Hyphens (`Merge-Sorted-Array-Notes.md`)
- Nesting: max 2 levels (`section/subsection/file.md`)
- Markdown features: emoji headings, emoji-blockquote callouts, mermaid diagrams, GFM tables, checklists, code blocks with language tags, ASCII traces, internal relative links

## Route Mapping
`backend/express/event-loop-notes.md` → `/docs/backend/express/event-loop-notes`
Catch-all route: `src/app/docs/[...slug]/page.tsx`

## Component Architecture
- DocsLayout (3-col), Header, Sidebar (collapsible tree), TOC (scroll-spy), CodeBlock (header + copy + syntax highlight + line numbers), Callout (6 types), ThemeProvider, Breadcrumb, Pagination

## Build Notes
- Content lives OUTSIDE web-version/ (in `../`). Must read at build time.
- Next.js 16 may have breaking changes — check `node_modules/next/dist/docs/` before writing new code.
