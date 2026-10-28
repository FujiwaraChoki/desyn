import Link from "next/link";
import { FOOTER_GROUPS, GITHUB_URL, TAGLINE } from "@/lib/site";
import { Wordmark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative overflow-hidden border-t border-fg/[0.07] pt-20">
      <div className="container-wide relative z-10">
        <div className="grid gap-14 lg:grid-cols-[1.2fr_2fr]">
          <div className="flex flex-col gap-5">
            <Wordmark />
            <p className="max-w-xs font-serif text-[26px] leading-[1.2] text-fg/80">{TAGLINE}</p>
            <ThemeToggle className="self-start" />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4">
            {FOOTER_GROUPS.map((group) => (
              <nav key={group.title} aria-label={group.title} className="flex flex-col gap-3">
                <h2 className="label mb-1 font-sans text-[11px]">{group.title}</h2>
                {group.links.map((link) =>
                  link.href.startsWith("http") ? (
                    <a
                      key={link.href}
                      href={link.href}
                      className="text-[14px] leading-6 text-fg/70 transition-colors duration-200 hover:text-sun-text"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={link.href}
                      href={link.href}
                      className="text-[14px] leading-6 text-fg/70 transition-colors duration-200 hover:text-sun-text"
                    >
                      {link.label}
                    </Link>
                  ),
                )}
                {group.title === "Company" && GITHUB_URL ? (
                  <a
                    href={GITHUB_URL}
                    rel="noopener"
                    className="text-[14px] leading-6 text-fg/70 transition-colors duration-200 hover:text-sun-text"
                  >
                    Source on GitHub
                  </a>
                ) : null}
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t border-fg/[0.07] py-6 text-[13px] text-subtle md:flex-row md:items-center md:justify-between">
          <p>© {year} Desyn. All rights reserved.</p>
          <p>
            Source-available, free for non-commercial use, under the{" "}
            <Link href="/legal/license" className="link">
              Desyn Non-Commercial Source License
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Oversized wordmark, cropped by the page edge: the sun setting into the footer. */}
      <div aria-hidden="true" className="pointer-events-none relative -mt-2 select-none">
        <div className="relative mx-auto flex max-w-[1600px] items-end justify-center overflow-hidden">
          <span className="block translate-y-[18%] bg-gradient-to-b from-fg/[0.16] to-fg/0 bg-clip-text font-serif text-[29vw] leading-[0.8] tracking-[-0.04em] text-transparent lg:text-[24vw] 2xl:text-[380px]">
            desyn
          </span>
        </div>
      </div>
    </footer>
  );
}
