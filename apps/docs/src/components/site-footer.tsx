import Link from "next/link";
import { SITE } from "@/lib/site";
import { SunMark } from "./site-header";

const LEGAL = [
  { href: `${SITE.legalUrl}/terms`, label: "Terms" },
  { href: `${SITE.legalUrl}/privacy`, label: "Privacy" },
  { href: `${SITE.legalUrl}/license`, label: "License" },
  { href: `${SITE.marketingUrl}/security`, label: "Security" },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-brand">
        <SunMark size={18} />
        <span>
          desyn <em>docs</em>
        </span>
      </div>
      <nav aria-label="Footer">
        <Link href="/changelog">Changelog</Link>
        <Link href="/legal">Legal</Link>
        {LEGAL.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
        <a href={`mailto:${SITE.contactEmail}`}>Contact</a>
      </nav>
      <p className="footer-note">Source-available under the Desyn Non-Commercial Source License.</p>
    </footer>
  );
}
