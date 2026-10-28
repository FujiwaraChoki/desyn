"use client";

import { useEffect, useMemo, useState } from "react";
import type { TocEntry } from "@/lib/remark-desyn";

/** Tracks which heading is currently being read: the last one above 25% of the viewport. */
function useActiveHeading(ids: string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    if (ids.length === 0) return;
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.25;
      let current = elements[0]?.id;
      for (const el of elements) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
        else break;
      }
      // At the very bottom of the page the last section is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = elements[elements.length - 1]?.id ?? current;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ids]);
  return active;
}

function TocList({ toc, active }: { toc: TocEntry[]; active: string | undefined }) {
  return (
    <ul className="toc-list">
      {toc.map((entry) => (
        <li key={entry.id} data-depth={entry.depth}>
          <a href={`#${entry.id}`} aria-current={entry.id === active ? "location" : undefined}>
            {entry.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Toc({ toc }: { toc: TocEntry[] }) {
  // Keep the id list referentially stable across renders so the scroll listener is not rebound.
  const key = toc.map((t) => t.id).join("|");
  const ids = useMemo(() => (key ? key.split("|") : []), [key]);
  const active = useActiveHeading(ids);
  if (toc.length === 0) return null;
  return (
    <nav className="toc" aria-label="On this page">
      <p className="toc-title">On this page</p>
      <TocList toc={toc} active={active} />
    </nav>
  );
}

/** Collapsible "On this page" for narrow screens where the right rail is hidden. */
export function InlineToc({ toc }: { toc: TocEntry[] }) {
  if (toc.length < 2) return null;
  return (
    <details className="toc-inline">
      <summary>On this page</summary>
      <TocList toc={toc} active={undefined} />
    </details>
  );
}
