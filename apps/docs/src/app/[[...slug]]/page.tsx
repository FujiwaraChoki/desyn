import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { mdxComponents } from "@/components/mdx-components";
import { PrevNext } from "@/components/page-footer";
import { InlineToc, Toc } from "@/components/toc";
import { FLAT_NAV, findNavItem, neighbours } from "@/lib/nav";
import { renderPage } from "@/lib/render";
import { plainTitle } from "@/lib/title";

interface Params {
  slug?: string[];
}

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return FLAT_NAV.map((item) => ({ slug: item.slug === "" ? [] : item.slug.split("/") }));
}

function slugOf(params: Params): string {
  return (params.slug ?? []).join("/");
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const slug = slugOf(await params);
  if (!findNavItem(slug)) return {};
  const { data } = await renderPage(slug);
  const title = plainTitle(data.frontmatter.title);
  const { description } = data.frontmatter;
  const path = slug === "" ? "/" : `/${slug}`;
  return {
    title: slug === "" ? { absolute: "Desyn Docs" } : title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path },
  };
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const slug = slugOf(await params);
  const item = findNavItem(slug);
  if (!item) notFound();
  const { Content, data } = await renderPage(slug);
  const { prev, next } = neighbours(slug);
  const isHome = slug === "";
  const { title, description } = data.frontmatter;

  return (
    <div className="doc-layout" data-home={isHome || undefined}>
      <article className="doc">
        <header className="doc-header">
          <p className="eyebrow">{item.sectionTitle}</p>
          <h1 className={isHome ? "display" : undefined}>{renderTitle(title)}</h1>
          <p className="lead">{description}</p>
        </header>
        <InlineToc toc={data.toc} />
        <div className="prose">
          <Content components={mdxComponents} />
        </div>
        <PrevNext prev={prev} next={next} />
      </article>
      <aside className="toc-rail">
        <Toc toc={data.toc} />
      </aside>
    </div>
  );
}

/** `*word*` in a frontmatter title renders as the italic accent word (design voice). */
function renderTitle(title: string) {
  const parts = title.split(/\*([^*]+)\*/g);
  return parts.map((part, i) => (i % 2 === 1 ? <em key={part}>{part}</em> : part));
}
