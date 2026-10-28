import type { Metadata } from "next";
import { ResetPassword } from "@/components/auth/inbox-forms";
import { translate } from "@/lib/i18n-core";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: translate("en", "auth.reset.metaTitle") };

export default async function ResetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  return <ResetPassword token={param(sp, "token")} error={param(sp, "error")} />;
}
