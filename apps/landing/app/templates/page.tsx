import type { Metadata } from "next";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Em } from "@/components/site/SectionIntro";
import { type GalleryItem, TemplatesGallery } from "@/components/templates/TemplatesGallery";
import { specForEntry, TEMPLATE_SPECS } from "@/lib/templates";
import { loadTemplateManifest } from "@/lib/templates-server";

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Layered, editable templates for posters, posts, stories, decks, menus, invitations, résumés and more.",
  alternates: { canonical: "/templates" },
};

export default async function TemplatesPage() {
  const manifest = await loadTemplateManifest();
  const fromManifest = manifest.length > 0;
  const items: GalleryItem[] = fromManifest
    ? manifest.map((m) => ({
        slug: m.slug,
        title: m.title,
        category: m.category,
        premium: m.premium,
        thumbnail: m.thumbnail,
        ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
        spec: specForEntry(m),
      }))
    : TEMPLATE_SPECS.map((s) => ({
        slug: s.slug,
        title: s.title,
        category: s.category,
        premium: false,
        thumbnail: null,
        spec: s,
      }));

  return (
    <>
      <PageHero
        eyebrow="Templates"
        title={
          <>
            Start from something <Em>good.</Em>
          </>
        }
      >
        {fromManifest
          ? `${manifest.length} templates, every one made of real, editable layers. Pick one, then change it by hand or ask the AI to remix it.`
          : "A taste of the template styles in Desyn. Every template is made of real, editable layers. The full library, searchable by description, opens in the app."}
      </PageHero>
      <section className="pb-24" aria-label="Template gallery">
        <div className="container-wide">
          <TemplatesGallery items={items} />
        </div>
      </section>
      <CtaBand
        title={
          <>
            Or skip the template and <Em>describe</Em> it.
          </>
        }
        body="Desyn builds a complete design from one sentence, then lets you edit it by talking."
      />
    </>
  );
}
