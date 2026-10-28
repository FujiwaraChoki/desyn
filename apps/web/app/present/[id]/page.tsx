import type { Metadata } from "next";
import { Suspense } from "react";
import { Splash } from "@/components/app/signed-in";
import { Presenter } from "@/components/present/presenter";
import type { Id } from "@/lib/convex-api";
import { translate } from "@/lib/i18n-core";

export const metadata: Metadata = { title: translate("en", "present.metaTitle") };

export default async function PresentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<Splash />}>
      <Presenter designId={id as Id<"designs">} />
    </Suspense>
  );
}
