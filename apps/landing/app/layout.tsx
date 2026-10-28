import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@/components/analytics/Analytics";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import { JsonLd } from "@/components/site/JsonLd";
import { readAnalyticsConfig } from "@/lib/consent";
import { organizationJsonLd, softwareApplicationJsonLd } from "@/lib/jsonld";
import { DESCRIPTION, SITE_NAME, SITE_URL, TITLE } from "@/lib/site";
import { themeBootScript } from "@/lib/theme";
import { instrumentSans, instrumentSerif, jetbrainsMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · Desyn",
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "Canva alternative",
    "source available",
    "design tool",
    "AI design",
    "self-hosted",
    "templates",
    "presentations",
    "social media graphics",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    { media: "(prefers-color-scheme: light)", color: "#0a0a0a" },
  ],
  colorScheme: "dark light",
};

const analyticsConfig = readAnalyticsConfig({
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_DATAFAST_WEBSITE_ID: process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID,
  NEXT_PUBLIC_DATAFAST_DOMAIN: process.env.NEXT_PUBLIC_DATAFAST_DOMAIN,
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${instrumentSerif.variable} ${instrumentSans.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme boot script, must run before paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <JsonLd data={[softwareApplicationJsonLd(), organizationJsonLd()]} />
      </head>
      <body>
        <Header />
        <main id="main" className="overflow-x-clip">
          {children}
        </main>
        <Footer />
        <div className="grain" aria-hidden="true" />
        <Analytics config={analyticsConfig} />
      </body>
    </html>
  );
}
