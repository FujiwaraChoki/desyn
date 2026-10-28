import { themeScript } from "@desyn/ui";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers/providers";
import { publicEnv } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.appUrl),
  title: { default: "Desyn", template: "%s · Desyn" },
  description:
    "Desyn, the AI-native design suite. Create, edit and understand designs as real layers.",
  applicationName: "Desyn",
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint (no flash). The script is a constant from @desyn/ui. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline boot script, no user data */}
        <script dangerouslySetInnerHTML={{ __html: themeScript() }} />
      </head>
      <body className="min-h-dvh bg-background font-sans text-fg antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
