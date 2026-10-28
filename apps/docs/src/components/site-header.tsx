"use client";

import { Menu, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SITE } from "@/lib/site";
import { loadSearchEngine, OPEN_SEARCH_EVENT } from "./search-dialog";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

/** The Desyn mark: two print crop corners around the sun (no SVG ids, so it can appear more than once). */
export function SunMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="sun-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        d="M6 17V6h11M31 42h11V31"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      <circle cx="24" cy="24" r="8.5" fill="var(--accent)" />
    </svg>
  );
}

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);

  // Close the drawer whenever the route changes (links, search, back/forward).
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  // Lock page scroll and listen for Escape while the drawer is open.
  useEffect(() => {
    document.documentElement.classList.toggle("drawer-open", menuOpen);
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header className="site-header">
      <div className="header-inner">
        <button
          type="button"
          className="icon-button menu-button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
        </button>
        <Link href="/" className="brand" aria-label="Desyn docs home">
          <SunMark />
          <span className="brand-word">desyn</span>
          <span className="brand-docs">docs</span>
        </Link>

        <button
          type="button"
          className="search-trigger"
          onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
          onPointerEnter={() => {
            loadSearchEngine().catch(() => undefined);
          }}
          aria-label="Search documentation"
        >
          <Search size={15} aria-hidden />
          <span className="search-trigger-label">Search docs</span>
          <span className="search-trigger-keys" aria-hidden>
            <kbd>
              <span className="k-mac">⌘</span>
              <span className="k-other">Ctrl</span>
            </kbd>
            <kbd>K</kbd>
          </span>
        </button>

        <nav className="header-links" aria-label="Desyn">
          <a href={SITE.marketingUrl}>desyn.app</a>
          <a href={SITE.appUrl} className="header-cta">
            Open app
          </a>
        </nav>
        <ThemeToggle />
      </div>

      <div
        id="mobile-nav"
        className="mobile-drawer"
        data-open={menuOpen || undefined}
        hidden={!menuOpen}
      >
        <Sidebar onNavigate={() => setMenuOpen(false)} />
        <div className="mobile-drawer-links">
          <a href={SITE.marketingUrl}>desyn.app</a>
          <a href={SITE.appUrl}>Open app</a>
        </div>
      </div>
    </header>
  );
}
