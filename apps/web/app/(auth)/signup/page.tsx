import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/signup-form";
import { translate } from "@/lib/i18n-core";
import { intentFromParams } from "@/lib/intent";
import { safeNext } from "@/lib/routes";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: translate("en", "auth.signup.metaTitle") };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const intent = intentFromParams({
    plan: param(sp, "plan"),
    interval: param(sp, "interval"),
    template: param(sp, "template"),
  });
  return <SignupForm intent={intent} next={safeNext(param(sp, "next"))} />;
}
