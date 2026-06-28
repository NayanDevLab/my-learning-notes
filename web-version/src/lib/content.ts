import fs from "fs";
import path from "path";
import matter from "gray-matter";

const CONTENT_ROOT = path.resolve(process.cwd(), "..");

const CONTENT_DIRS = [
  "backend",
  "databases",
  "dsa",
  "sql",
  "system-design",
] as const;

export interface NavLeaf {
  type: "leaf";
  title: string;
  slug: string[];
}

export interface NavGroup {
  type: "group";
  title: string;
  slug: string[];
  children: NavItem[];
}

export type NavItem = NavLeaf | NavGroup;

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/, "")
    .replace(/-Notes$/, "")
    .replace(/-/g, " ");
}

function titleFromHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1]
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}️‍]+\s*/u, "")
    .trim();
}

function titleFromDirname(dirname: string): string {
  return dirname
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function walkDir(dirPath: string, slugPrefix: string[]): NavItem[] {
  if (!fs.existsSync(dirPath)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const items: NavItem[] = [];

  const subdirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const mdFiles = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".md") &&
        e.name.toLowerCase() !== "readme.md"
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of subdirs) {
    const childSlug = [...slugPrefix, dir.name];
    const children = walkDir(path.join(dirPath, dir.name), childSlug);
    if (children.length > 0) {
      items.push({
        type: "group",
        title: titleFromDirname(dir.name),
        slug: childSlug,
        children,
      });
    }
  }

  for (const file of mdFiles) {
    const baseName = file.name.replace(/\.md$/, "");
    const slug = [...slugPrefix, baseName];
    const filePath = path.join(dirPath, file.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const heading = titleFromHeading(raw);
    items.push({
      type: "leaf",
      title: heading || titleFromFilename(file.name),
      slug,
    });
  }

  return items;
}

let cachedNavTree: NavItem[] | null = null;

export function getNavTree(): NavItem[] {
  if (cachedNavTree) return cachedNavTree;

  const tree: NavItem[] = [];
  for (const dir of CONTENT_DIRS) {
    const dirPath = path.join(CONTENT_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    const children = walkDir(dirPath, [dir]);
    if (children.length > 0) {
      tree.push({
        type: "group",
        title: titleFromDirname(dir),
        slug: [dir],
        children,
      });
    }
  }
  cachedNavTree = tree;
  return tree;
}

function collectSlugs(items: NavItem[]): string[][] {
  const slugs: string[][] = [];
  for (const item of items) {
    if (item.type === "leaf") {
      slugs.push(item.slug);
    } else {
      slugs.push(...collectSlugs(item.children));
    }
  }
  return slugs;
}

export function getAllSlugs(): string[][] {
  return collectSlugs(getNavTree());
}

export interface NoteContent {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  slug: string[];
}

export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export function extractHeadings(markdown: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const lines = markdown.split("\n");
  for (const line of lines) {
    const m2 = line.match(/^##\s+(.+)$/);
    const m3 = line.match(/^###\s+(.+)$/);
    const match = m3 || m2;
    if (!match) continue;
    const level = m3 ? 3 : 2;
    const raw = match[1];
    const text = raw
      .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}️‍]+\s*/u, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .trim();
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (id && text) {
      headings.push({ id, text, level: level as 2 | 3 });
    }
  }
  return headings;
}

export interface SearchEntry {
  slug: string;
  title: string;
  section: string;
  snippet: string;
}

export function buildSearchIndex(): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const tree = getNavTree();

  function walk(items: NavItem[], sectionLabel: string) {
    for (const item of items) {
      if (item.type === "leaf") {
        const filePath = path.join(CONTENT_ROOT, ...item.slug) + ".md";
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, "utf-8");
        const body = matter(raw).content;
        const plain = body
          .replace(/```[\s\S]*?```/g, "")
          .replace(/^#+\s+/gm, "")
          .replace(/[*_`~\[\]()>|#-]/g, "")
          .replace(/\n+/g, " ")
          .trim();
        entries.push({
          slug: "/" + item.slug.join("/"),
          title: item.title,
          section: sectionLabel,
          snippet: plain.slice(0, 200),
        });
      } else {
        walk(item.children, item.title);
      }
    }
  }

  for (const sec of tree) {
    walk(sec.type === "group" ? sec.children : [sec], sec.title);
  }
  return entries;
}

export interface PrevNext {
  prev: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
}

export function getPrevNext(currentSlug: string[]): PrevNext {
  const all = getAllSlugs();
  const currentPath = currentSlug.join("/");
  const idx = all.findIndex((s) => s.join("/") === currentPath);
  return {
    prev:
      idx > 0
        ? {
            slug: "/" + all[idx - 1].join("/"),
            title: getNoteTitle(all[idx - 1]),
          }
        : null,
    next:
      idx < all.length - 1
        ? {
            slug: "/" + all[idx + 1].join("/"),
            title: getNoteTitle(all[idx + 1]),
          }
        : null,
  };
}

function getNoteTitle(slug: string[]): string {
  const tree = getNavTree();
  function find(items: NavItem[]): string | null {
    for (const item of items) {
      if (item.type === "leaf" && item.slug.join("/") === slug.join("/")) {
        return item.title;
      }
      if (item.type === "group") {
        const found = find(item.children);
        if (found) return found;
      }
    }
    return null;
  }
  return find(tree) || slug[slug.length - 1].replace(/-/g, " ");
}

export function getNoteBySlug(slug: string[]): NoteContent | null {
  const filePath = path.join(CONTENT_ROOT, ...slug) + ".md";
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data: frontmatter, content: body } = matter(raw);
  const heading = titleFromHeading(body);
  const title =
    (frontmatter.title as string) ||
    heading ||
    titleFromFilename(slug[slug.length - 1]);

  return { title, frontmatter, body, slug };
}
