export type LegalSlug = "terms" | "privacy" | "cookies" | "license" | "dpa";

export interface LegalDoc {
  slug: LegalSlug;
  title: string;
  description: string;
}

export const LEGAL_UPDATED = "20 October 2026";

export const LEGAL_DOCS: LegalDoc[] = [
  {
    slug: "terms",
    title: "Terms of Service",
    description: "The agreement between you and Desyn when you use desyn.app.",
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    description: "What we collect, why, who processes it and your rights.",
  },
  {
    slug: "cookies",
    title: "Cookies",
    description: "Every cookie and storage key Desyn uses, and how to change your choice.",
  },
  {
    slug: "license",
    title: "Source License",
    description: "The Desyn Non-Commercial Source License in plain words, with the full text.",
  },
  {
    slug: "dpa",
    title: "Data Processing Addendum",
    description: "How we process personal data on behalf of Pro customers.",
  },
];

/** Third parties that process personal data for the hosted service (from docs/SPEC.md). */
export const SUBPROCESSORS: { name: string; purpose: string; data: string }[] = [
  {
    name: "Hetzner Online",
    purpose: "Server hosting for the application, database and render worker",
    data: "All service data",
  },
  {
    name: "Amazon Web Services (S3, SES)",
    purpose: "File storage for uploads, assets and exports; transactional email",
    data: "Files you upload or generate; email address",
  },
  {
    name: "Stripe",
    purpose: "Payments, invoices and the billing portal for Pro",
    data: "Name, email, billing details (card data stays with Stripe)",
  },
  {
    name: "OpenRouter",
    purpose: "Routing AI text requests to model providers when you use hosted AI",
    data: "Prompts and the design content sent with them",
  },
  {
    name: "Fal",
    purpose: "Image and video generation and editing when you use hosted AI",
    data: "Prompts and images sent with them",
  },
  {
    name: "PostHog (EU cloud)",
    purpose: "Product analytics",
    data: "Usage events, device and browser data",
  },
  {
    name: "DataFast",
    purpose: "Website visit analytics on desyn.app, only after consent",
    data: "Pages visited, referrer, device and browser data",
  },
  {
    name: "Axiom",
    purpose: "Operational logs and error monitoring",
    data: "Request metadata, error details",
  },
];
