import Link from "next/link";
import type { PrevNext } from "@/lib/content";

export function Pagination({ prevNext }: { prevNext: PrevNext }) {
  const { prev, next } = prevNext;
  if (!prev && !next) return null;

  return (
    <nav aria-label="Pagination" className="pagination">
      {prev ? (
        <Link href={prev.slug} className="pagination-card">
          <span className="pagination-direction">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Previous
          </span>
          <span className="pagination-title">{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={next.slug} className="pagination-card pagination-card-next">
          <span className="pagination-direction">
            Next
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="pagination-title">{next.title}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
