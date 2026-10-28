import type { Metadata } from "next";
import { Suspense } from "react";
import { SignedIn, Splash } from "@/components/app/signed-in";
import { EditorMount } from "@/components/editor/editor-mount";

export const metadata: Metadata = { title: "Editor" };

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<Splash />}>
      <SignedIn onboarding="skip">
        <EditorMount key={id} designId={id} />
      </SignedIn>
    </Suspense>
  );
}
