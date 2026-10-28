import type { Metadata } from "next";
import { AdminConsole } from "@/components/admin/admin-console";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "admin.metaTitle") };

export default function AdminPage() {
  return <AdminConsole />;
}
