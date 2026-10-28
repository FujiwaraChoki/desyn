import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Cookies, Dpa, License, Privacy, Terms } from "@/components/legal/Documents";
import { LegalLayout } from "@/components/site/LegalLayout";
import { analyticsEnabled, readAnalyticsConfig } from "@/lib/consent";
import { LEGAL_DOCS, LEGAL_UPDATED, type LegalSlug } from "@/lib/content/legal";

export const dynamicParams = false;

export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ doc: d.slug }));
}

function find(slug: string) {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ doc: string }>;
}): Promise<Metadata> {
  const doc = find((await params).doc);
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: `/legal/${doc.slug}` },
  };
}

/** The repository LICENSE, read at build time so the page always matches the real text. */
async function licenseText(): Promise<string | null> {
  for (const file of [join(process.cwd(), "..", "..", "LICENSE"), join(process.cwd(), "LICENSE")]) {
    try {
      // Build-time only (the page is static): keep the file out of server tracing.
      return await readFile(/*turbopackIgnore: true*/ file, "utf8");
    } catch {
      // try the next location
    }
  }
  return null;
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const doc = find((await params).doc);
  if (!doc) notFound();
  const slug = doc.slug as LegalSlug;
  const analytics = analyticsEnabled(
    readAnalyticsConfig({
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      NEXT_PUBLIC_DATAFAST_WEBSITE_ID: process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID,
      NEXT_PUBLIC_DATAFAST_DOMAIN: process.env.NEXT_PUBLIC_DATAFAST_DOMAIN,
    }),
  ).any;

  return (
    <LegalLayout slug={slug} title={doc.title} updated={LEGAL_UPDATED} intro={doc.description}>
      {slug === "terms" && <Terms />}
      {slug === "privacy" && <Privacy />}
      {slug === "cookies" && <Cookies analyticsEnabled={analytics} />}
      {slug === "license" && <License fullText={await licenseText()} />}
      {slug === "dpa" && <Dpa />}
    </LegalLayout>
  );
}
