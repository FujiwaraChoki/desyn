import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { resolveBasePath } from "./src/lib/base-path.ts";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(appDir, "../..");

// The docs run standalone at docs.desyn.app (basePath "") or as a Next.js multi-zone mounted
// under desyn.app/docs (build with DOCS_BASE_PATH=/docs). basePath is inlined at build time.
const basePath = resolveBasePath(process.env.DOCS_BASE_PATH);

// `output: "standalone"` is not set here: the Docker build (deploy/docker/next.Dockerfile) enables it
// with NEXT_PRIVATE_STANDALONE=1, and leaving it off keeps `next start` working for local checks.
const nextConfig: NextConfig = {
  basePath,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_DOCS_BASE_PATH: basePath },
  // Content (MDX, docs/DOCUMENT_MODEL.md, config/plans.json) is read from disk while prerendering.
  // Every page is static, but trace the sources so a standalone server can always render them.
  outputFileTracingIncludes: {
    "/**": ["./content/**/*", "../../docs/DOCUMENT_MODEL.md", "../../config/plans.json"],
  },
};

export default nextConfig;
