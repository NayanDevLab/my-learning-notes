import fs from "fs";
import path from "path";
import matter from "gray-matter";

const CONTENT_ROOT = path.resolve(__dirname, "../..");
const OUT_PATH = path.resolve(__dirname, "../public/search-index.json");

const CONTENT_DIRS = ["backend", "databases", "dsa", "sql", "system-design"];

interface SearchEntry {
  slug: string;
  title: string;
  section: string;
  snippet: string;
}

function titleFromHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1]
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/u, "")
    .trim();
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "").replace(/-Notes$/, "").replace(/-/g, " ");
}

function titleFromDirname(dirname: string): string {
  return dirname.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function walkDir(
  dirPath: string,
  slugPrefix: string[],
  sectionLabel: string,
  entries: SearchEntry[]
) {
  if (!fs.existsSync(dirPath)) return;
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  const subdirs = items
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const mdFiles = items
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of subdirs) {
    walkDir(
      path.join(dirPath, dir.name),
      [...slugPrefix, dir.name],
      titleFromDirname(dir.name),
      entries
    );
  }

  for (const file of mdFiles) {
    const filePath = path.join(dirPath, file.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const { content: body } = matter(raw);

    const title = titleFromHeading(body) || titleFromFilename(file.name);

    const plain = body
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^#+\s+/gm, "")
      .replace(/[*_`~\[\]()>|#-]/g, "")
      .replace(/\n+/g, " ")
      .trim();

    const baseName = file.name.replace(/\.md$/, "");
    entries.push({
      slug: "/" + [...slugPrefix, baseName].join("/"),
      title,
      section: sectionLabel,
      snippet: plain.slice(0, 200),
    });
  }
}

function generate() {
  const entries: SearchEntry[] = [];
  for (const dir of CONTENT_DIRS) {
    const dirPath = path.join(CONTENT_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    walkDir(dirPath, [dir], titleFromDirname(dir), entries);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(entries));

  const sizeKB = (Buffer.byteLength(JSON.stringify(entries)) / 1024).toFixed(1);
  console.log(
    `[search-index] ${entries.length} entries, ${sizeKB} KB → public/search-index.json`
  );
}

generate();
