import type { Metadata } from "next";
import { Trash } from "@/components/dashboard/design-lists";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "dashboard.trash.title") };

export default function TrashPage() {
  return <Trash />;
}
