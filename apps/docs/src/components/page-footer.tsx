import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import type { FlatNavItem } from "@/lib/nav";

export function PrevNext({ prev, next }: { prev?: FlatNavItem; next?: FlatNavItem }) {
  if (!prev && !next) return null;
  return (
    <nav className="prev-next" aria-label="Previous and next pages">
      {prev ? (
        <Link href={prev.href} className="pn-link" data-dir="prev">
          <span className="pn-label">
            <ArrowLeft size={14} aria-hidden /> Previous
          </span>
          <span className="pn-title">{prev.label}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={next.href} className="pn-link" data-dir="next">
          <span className="pn-label">
            Next <ArrowRight size={14} aria-hidden />
          </span>
          <span className="pn-title">{next.label}</span>
        </Link>
      ) : null}
    </nav>
  );
}
