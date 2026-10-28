import type { Metadata } from "next";
import { Suspense } from "react";
import { SignedIn, Splash } from "@/components/app/signed-in";
import { Onboarding } from "@/components/onboarding/onboarding";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "onboarding.metaTitle") };

export default function OnboardingPage() {
  return (
    <Suspense fallback={<Splash />}>
      <SignedIn onboarding="skip">
        <Onboarding />
      </SignedIn>
    </Suspense>
  );
}
