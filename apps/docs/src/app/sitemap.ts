import type { MetadataRoute } from "next";
import { FLAT_NAV } from "@/lib/nav";
import { BASE_PATH, SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return FLAT_NAV.map((item) => ({
    url: `${SITE.url}${BASE_PATH}${item.href === "/" ? "" : item.href}`,
    changeFrequency: "weekly",
    priority: item.href === "/" ? 1 : 0.6,
  }));
}
