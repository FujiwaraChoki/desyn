import type { Metadata } from "next";
import { BrandPage } from "@/components/brand/brand-page";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "brand.metaTitle") };

export default function Brand() {
  return <BrandPage />;
}
