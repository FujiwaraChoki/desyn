import type { Metadata } from "next";
import { Suspense } from "react";
import { SignedIn, Splash } from "@/components/app/signed-in";
import { NativeAuthorize } from "@/components/public/native-authorize";
import { translate } from "@/lib/i18n-core";
import { parseNativeRequest } from "@/lib/native";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: translate("en", "auth.native.metaTitle") };

export default async function NativeAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const request = parseNativeRequest({
    client: param(sp, "client"),
    redirect_uri: param(sp, "redirect_uri"),
    code_challenge: param(sp, "code_challenge"),
    code_challenge_method: param(sp, "code_challenge_method"),
    state: param(sp, "state"),
  });
  return (
    <Suspense fallback={<Splash />}>
      <SignedIn onboarding="skip">
        <NativeAuthorize request={request} />
      </SignedIn>
    </Suspense>
  );
}
