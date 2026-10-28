import { planConfig } from "./plans";
import { DESCRIPTION, SITE_NAME, SITE_URL } from "./site";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function softwareApplicationJsonLd(): Record<string, Json> {
  const { free, pro } = planConfig.plans;
  const currency = planConfig.currency.toUpperCase();
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: SITE_URL,
    description: DESCRIPTION,
    applicationCategory: "DesignApplication",
    operatingSystem: "Web, macOS, Windows, Linux, iOS",
    offers: [
      {
        "@type": "Offer",
        name: free.name,
        price: String(free.priceMonthly),
        priceCurrency: currency,
        url: `${SITE_URL}/pricing`,
      },
      {
        "@type": "Offer",
        name: `${pro.name} (monthly)`,
        price: String(pro.priceMonthly),
        priceCurrency: currency,
        url: `${SITE_URL}/pricing`,
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: String(pro.priceMonthly),
          priceCurrency: currency,
          unitCode: "MON",
        },
      },
      ...(pro.priceYearly
        ? [
            {
              "@type": "Offer",
              name: `${pro.name} (yearly)`,
              price: String(pro.priceYearly),
              priceCurrency: currency,
              url: `${SITE_URL}/pricing`,
              priceSpecification: {
                "@type": "UnitPriceSpecification",
                price: String(pro.priceYearly),
                priceCurrency: currency,
                unitCode: "ANN",
              },
            } satisfies Record<string, Json>,
          ]
        : []),
    ],
  };
}

export function organizationJsonLd(): Record<string, Json> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icon.svg`,
  };
}

export function faqJsonLd(items: { q: string; a: string }[]): Record<string, Json> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

/** Serialises JSON-LD safely for a <script> tag (no `</script>` breakouts). */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
