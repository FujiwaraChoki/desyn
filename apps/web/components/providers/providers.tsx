"use client";

import { DesynProvider } from "@desyn/ui";
import type { ReactNode } from "react";
import { Analytics } from "@/components/analytics/analytics";
import { WebVitals } from "@/components/analytics/web-vitals";
import { I18nProvider } from "@/lib/i18n";
import { ConvexProvider } from "./convex-provider";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en">
      <DesynProvider defaultTheme="dark">
        <ConvexProvider>{children}</ConvexProvider>
        <Analytics />
        <WebVitals />
      </DesynProvider>
    </I18nProvider>
  );
}
