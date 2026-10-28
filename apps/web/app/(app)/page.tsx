import type { Metadata } from "next";
import { Home } from "@/components/dashboard/home";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "dashboard.homeTitle") };

export default function HomePage() {
  return <Home />;
}
