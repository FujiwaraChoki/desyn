import type { Metadata } from "next";
import { TemplatesPage } from "@/components/templates/templates-page";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "templates.metaTitle") };

export default function Templates() {
  return <TemplatesPage />;
}
