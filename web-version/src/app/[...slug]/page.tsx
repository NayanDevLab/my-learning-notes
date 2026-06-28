import { notFound } from "next/navigation";
import {
  getAllSlugs,
  getNoteBySlug,
  getNavTree,
  extractHeadings,
} from "@/lib/content";
import { preHighlightCodeBlocks } from "@/lib/process-markdown";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { TableOfContents } from "@/components/toc";
import { MarkdownBody } from "./markdown-body";

export async function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export const dynamicParams = false;

export default async function NotePage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const note = getNoteBySlug(slug);
  if (!note) notFound();

  const navTree = getNavTree();
  const headings = extractHeadings(note.body);

  const highlightedMap = await preHighlightCodeBlocks(note.body);
  const highlightedBlocks: Record<
    string,
    import("@/lib/process-markdown").ProcessedCodeBlock
  > = {};
  for (const [key, value] of highlightedMap) {
    highlightedBlocks[key] = value;
  }

  const breadcrumb = slug
    .slice(0, -1)
    .map((s) =>
      s
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    );

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

      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        <Sidebar items={navTree} currentSlug={slug} />

        <main
          data-col="main"
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            scrollBehavior: "smooth",
            padding: "0 56px",
          }}
        >
          <article
            style={{
              maxWidth: 720,
              margin: "0 auto",
              padding: "54px 0 150px",
            }}
          >
            {breadcrumb.length > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontSize: 13,
                  color: "var(--muted)",
                  margin: "0 0 18px",
                  fontWeight: 500,
                }}
              >
                {breadcrumb.map((part, i) => (
                  <span key={i}>
                    {i > 0 && (
                      <span style={{ opacity: 0.6, margin: "0 4px" }}>/</span>
                    )}
                    {part}
                  </span>
                ))}
              </div>
            )}

            <div className="prose">
              <MarkdownBody
                content={note.body}
                highlightedBlocks={highlightedBlocks}
              />
            </div>
          </article>
        </main>

        <TableOfContents headings={headings} />
      </div>
    </div>
  );
}
