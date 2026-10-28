import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { translate } from "@/lib/i18n-core";
import { safeNext } from "@/lib/routes";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: translate("en", "auth.login.metaTitle") };

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const error = param(sp, "error");
  const notice = param(sp, "notice");
  return (
    <LoginForm
      next={safeNext(param(sp, "next"))}
      initialError={error ? translate("en", "auth.verify.expiredBody") : undefined}
      initialNotice={
        notice === "deleted" ? translate("en", "auth.login.accountDeleted") : undefined
      }
    />
  );
}
