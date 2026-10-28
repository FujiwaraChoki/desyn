import type { Metadata } from "next";
import { AcceptInvite } from "@/components/public/accept-invite";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "invite.metaTitle") };

export default async function AcceptPage({ params }: { params: Promise<{ invite: string }> }) {
  const { invite } = await params;
  return <AcceptInvite token={decodeURIComponent(invite)} />;
}
