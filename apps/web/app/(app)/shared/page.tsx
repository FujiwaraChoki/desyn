import type { Metadata } from "next";
import { SharedWithMe } from "@/components/dashboard/design-lists";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "dashboard.shared.title") };

export default function SharedPage() {
  return <SharedWithMe />;
}
