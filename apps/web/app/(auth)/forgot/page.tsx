import type { Metadata } from "next";
import { ForgotPassword } from "@/components/auth/inbox-forms";
import { translate } from "@/lib/i18n-core";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: translate("en", "auth.forgot.metaTitle") };

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  return <ForgotPassword email={param(sp, "email")} />;
}
