import type { NextConfig } from "next";

/*
 * Security headers (CSP, X-Frame-Options, HSTS, ...) are set by the nginx front end for desyn.app
 * (deploy/nginx/desyn/snippets/headers.conf). Setting them here as well would send duplicates.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { formats: ["image/avif", "image/webp"] },
};

export default nextConfig;
