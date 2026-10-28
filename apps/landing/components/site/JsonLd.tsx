import { serializeJsonLd } from "@/lib/jsonld";

export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD must be inline; serializeJsonLd escapes <, > and &.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
