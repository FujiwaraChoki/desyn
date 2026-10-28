import type { Metadata } from "next";
import { MagicLinkSent } from "@/components/auth/inbox-forms";
import { translate } from "@/lib/i18n-core";
import { safeNext } from "@/lib/routes";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: translate("en", "auth.magic.metaTitle") };

export default async function MagicPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  return (
    <MagicLinkSent
      email={param(sp, "email")}
      error={param(sp, "error")}
      next={safeNext(param(sp, "next"))}
    />
  );
}
