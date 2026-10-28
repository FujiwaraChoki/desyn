import { FEATURES } from "./content/features";
import { LEGAL_DOCS } from "./content/legal";

/** Every public, indexable page. Used by the sitemap and by tests. */
export function publicRoutes(): {
  path: string;
  priority: number;
  changeFrequency: "weekly" | "monthly" | "yearly";
}[] {
  return [
    { path: "/", priority: 1, changeFrequency: "weekly" },
    { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
    { path: "/features", priority: 0.9, changeFrequency: "monthly" },
    ...FEATURES.map((f) => ({
      path: `/features/${f.slug}`,
      priority: 0.8,
      changeFrequency: "monthly" as const,
    })),
    { path: "/templates", priority: 0.8, changeFrequency: "weekly" },
    { path: "/download", priority: 0.7, changeFrequency: "monthly" },
    { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
    { path: "/about", priority: 0.5, changeFrequency: "yearly" },
    { path: "/security", priority: 0.5, changeFrequency: "yearly" },
    { path: "/contact", priority: 0.5, changeFrequency: "yearly" },
    ...LEGAL_DOCS.map((d) => ({
      path: `/legal/${d.slug}`,
      priority: 0.3,
      changeFrequency: "yearly" as const,
    })),
  ];
}
