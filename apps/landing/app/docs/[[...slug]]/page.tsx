import { ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { DOCS_URL } from "@/lib/site";

/*
 * The documentation is its own app (apps/docs at docs.desyn.app). This page answers desyn.app/docs/*
 * with a calm index instead of a redirect: the docs host falls back to desyn.app/docs while its
 * container is down, and a redirect back would loop.
 */

export const metadata: Metadata = {
  title: "Documentation",
  description: "Guides for the editor, the AI, self-hosting and the developer API.",
  alternates: { canonical: "/docs" },
  robots: { index: false, follow: true },
};

const SECTIONS = [
  { path: "", title: "Overview", body: "What Desyn is and how the pieces fit together." },
  { path: "/editor", title: "Editor", body: "Layers, text, shapes, images, pages and every tool." },
  { path: "/ai", title: "AI", body: "Generating, editing by talking, providers and credits." },
  {
    path: "/self-hosting",
    title: "Self-hosting",
    body: "Run every feature on your own server, free for non-commercial use.",
  },
  {
    path: "/developers",
    title: "Developers",
    body: "The document model, the REST API and the MCP server.",
  },
];

export function generateStaticParams() {
  return [
    { slug: [] },
    ...SECTIONS.filter((s) => s.path).map((s) => ({ slug: [s.path.slice(1)] })),
  ];
}

export default async function DocsIndex({ params }: { params: Promise<{ slug?: string[] }> }) {
  const slug = (await params).slug ?? [];
  const requested = slug.length ? `/${slug.map(encodeURIComponent).join("/")}` : "";
  return (
    <>
      <PageHero
        eyebrow="Documentation"
        title={
          <>
            The <Em>manual.</Em>
          </>
        }
        actions={
          <a href={`${DOCS_URL}${requested}`} className="btn btn-primary btn-lg">
            Open {requested ? "this page" : "the docs"}{" "}
            <ArrowUpRight size={17} strokeWidth={1.75} aria-hidden="true" />
          </a>
        }
      >
        Desyn’s documentation lives at{" "}
        <span className="text-fg">{DOCS_URL.replace(/^https?:\/\//, "")}</span>.
      </PageHero>
      <section className="pb-28" aria-label="Sections">
        <div className="container-wide">
          <div className="mx-auto grid max-w-5xl gap-px overflow-hidden rounded-[24px] border border-fg/10 bg-fg/10 sm:grid-cols-2 lg:grid-cols-3">
            {SECTIONS.map((s, i) => (
              <Reveal key={s.title} delay={(i % 3) * 0.05} className="bg-bg">
                <a
                  href={`${DOCS_URL}${s.path}`}
                  className="group flex h-full flex-col p-8 transition-colors hover:bg-surface-1"
                >
                  <h2 className="font-serif text-[28px] leading-tight">{s.title}</h2>
                  <p className="mt-2 text-[15px] leading-6 text-fg/65">{s.body}</p>
                  <ArrowUpRight
                    size={16}
                    strokeWidth={1.5}
                    className="mt-5 text-subtle transition-colors group-hover:text-sun"
                    aria-hidden="true"
                  />
                </a>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
