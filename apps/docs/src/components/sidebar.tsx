"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { hrefForSlug, isNested, NAV } from "@/lib/nav";

function normalize(pathname: string): string {
  return pathname !== "/" ? pathname.replace(/\/+$/, "") : pathname;
}

/** Left navigation. Sections collapse; the one containing the current page starts open. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = normalize(usePathname() ?? "/");
  const currentSection = NAV.find((s) => s.items.some((i) => hrefForSlug(i.slug) === pathname))?.id;
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NAV.map((s) => [s.id, s.id === currentSection || s.id === "start"])),
  );
  const navRef = useRef<HTMLElement>(null);
  // The sidebar renders twice (desktop rail and mobile drawer), so list ids must be unique.
  const idPrefix = useId();

  useEffect(() => {
    if (currentSection)
      setOpen((prev) => (prev[currentSection] ? prev : { ...prev, [currentSection]: true }));
  }, [currentSection]);

  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <nav className="sidebar-nav" aria-label="Documentation" ref={navRef}>
      {NAV.map((section) => {
        const isOpen = open[section.id] ?? false;
        return (
          <div key={section.id} className="nav-section">
            <button
              type="button"
              className="nav-section-title"
              aria-expanded={isOpen}
              aria-controls={`${idPrefix}-${section.id}`}
              onClick={() => setOpen((prev) => ({ ...prev, [section.id]: !isOpen }))}
            >
              <span>{section.title}</span>
              <ChevronRight size={14} aria-hidden className="nav-chevron" />
            </button>
            <ul id={`${idPrefix}-${section.id}`} hidden={!isOpen}>
              {section.items.map((item) => {
                const href = hrefForSlug(item.slug);
                const nested = isNested(item.slug, section);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={href === pathname ? "page" : undefined}
                      data-nested={nested || undefined}
                      onClick={onNavigate}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
