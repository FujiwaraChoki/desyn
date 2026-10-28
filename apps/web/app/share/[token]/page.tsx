import type { Metadata } from "next";
import { ShareView } from "@/components/public/share-view";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = {
  title: translate("en", "share.metaTitle"),
  robots: { index: false },
};

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareView token={decodeURIComponent(token)} />;
}
