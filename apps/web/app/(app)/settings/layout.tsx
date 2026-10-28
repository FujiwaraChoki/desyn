import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SettingsLayout } from "@/components/settings/settings-ui";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "settings.metaTitle") };

export default function Layout({ children }: { children: ReactNode }) {
  return <SettingsLayout>{children}</SettingsLayout>;
}
