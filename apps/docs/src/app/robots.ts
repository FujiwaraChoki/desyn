import type { MetadataRoute } from "next";
import { BASE_PATH, SITE } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${SITE.url}${BASE_PATH}/sitemap.xml` };
}
