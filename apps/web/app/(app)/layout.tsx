import type { ReactNode } from "react";
import { Suspense } from "react";
import { AppShell } from "@/components/app/app-shell";
import { SignedIn, Splash } from "@/components/app/signed-in";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<Splash />}>
      <SignedIn>
        <AppShell>{children}</AppShell>
      </SignedIn>
    </Suspense>
  );
}
