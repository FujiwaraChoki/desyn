import { ArrowUpRight, Bell } from "lucide-react";
import type { Metadata } from "next";
import { BrowserFrame, DesktopFrame, PhoneFrame } from "@/components/platforms/Devices";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { APP_URL, CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Desyn runs in the browser today. Native apps for macOS, Windows, Linux, iPhone and iPad are in development.",
  alternates: { canonical: "/download" },
};

function notify(platform: string) {
  const subject = encodeURIComponent(`Tell me when Desyn for ${platform} is ready`);
  return `mailto:${CONTACT_EMAIL}?subject=${subject}`;
}

const PLATFORMS = [
  {
    name: "Web",
    status: "Available",
    live: true,
    body: "The full editor in any modern browser: Chrome, Edge, Firefox and Safari. Nothing to install, always up to date.",
    frame: <BrowserFrame />,
    action: { href: APP_URL, label: "Open Desyn" },
  },
  {
    name: "macOS, Windows and Linux",
    status: "In development",
    live: false,
    body: "A native desktop app built in Rust, with the same engine as the web. Works offline with a local library that syncs when you are back online.",
    frame: <DesktopFrame />,
    action: { href: notify("desktop"), label: "Email me when it ships" },
  },
  {
    name: "iPhone and iPad",
    status: "In development",
    live: false,
    body: "A native SwiftUI app with multi-touch editing, Apple Pencil support and the AI dock, synced with your other devices.",
    frame: (
      <div className="mx-auto w-[46%] max-w-[220px]">
        <PhoneFrame />
      </div>
    ),
    action: { href: notify("iPhone and iPad"), label: "Email me when it ships" },
  },
];

export default function DownloadPage() {
  return (
    <>
      <PageHero
        eyebrow="Download"
        title={
          <>
            Desyn, <Em>everywhere.</Em>
          </>
        }
      >
        Start in the browser today. The native apps share the same engine and are on their way.
      </PageHero>
      <section className="pb-24" aria-label="Platforms">
        <div className="container-wide flex flex-col gap-6">
          {PLATFORMS.map((p, i) => (
            <Reveal key={p.name} delay={i * 0.06}>
              <article className="grid items-center gap-10 rounded-[28px] border border-fg/10 bg-surface-1/50 p-6 sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
                <div>
                  <span
                    className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px] ${
                      p.live ? "bg-success/15 text-success-text" : "bg-sun/12 text-sun-text"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${p.live ? "bg-success" : "animate-pulse bg-sun"}`}
                    />
                    {p.status}
                  </span>
                  <h2 className="mt-5 font-serif text-[clamp(34px,3.6vw,52px)] leading-[1.04]">
                    {p.name}
                  </h2>
                  <p className="body mt-4 max-w-md">{p.body}</p>
                  <a
                    href={p.action.href}
                    className={`btn btn-md mt-8 ${p.live ? "btn-primary" : "btn-secondary"}`}
                  >
                    {p.live ? (
                      <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <Bell size={16} strokeWidth={1.5} aria-hidden="true" />
                    )}
                    {p.action.label}
                  </a>
                </div>
                <div>{p.frame}</div>
              </article>
            </Reveal>
          ))}
          <p className="mt-6 text-center text-[13.5px] text-subtle">
            We will not list store badges or download links until the apps are actually available.
          </p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
