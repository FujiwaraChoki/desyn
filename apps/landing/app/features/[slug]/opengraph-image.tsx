import { FEATURES, featureBySlug } from "@/lib/content/features";
import { OG_SIZE, ogImage } from "@/lib/og";

export const alt = "Desyn feature";
export const size = OG_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const f = featureBySlug((await params).slug);
  const title = f ? `${f.title[0]}*${f.title[1]}*${f.title[2] ?? ""}` : "Desyn";
  return ogImage({ eyebrow: f?.eyebrow ?? "Features", title });
}
