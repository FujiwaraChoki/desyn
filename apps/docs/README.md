# @desyn/docs

The Desyn documentation site (docs.desyn.app): Next.js 16 App Router, MDX content, static full-text search, the sun
edition of the Atmospheric Minimalism design system. Every page is prerendered at build time.

```bash
pnpm --filter @desyn/docs dev          # http://localhost:4103
pnpm --filter @desyn/docs build
pnpm --filter @desyn/docs start        # serves the build on :4103
pnpm --filter @desyn/docs test         # content, generators, search ranking, link check (offline)
pnpm --filter @desyn/docs typecheck
pnpm --filter @desyn/docs lint
```

With a server running (`start`, or `DOCS_URL=<origin>` for any other):

```bash
pnpm --filter @desyn/docs check:links    # source-level link + anchor check (no server needed)
pnpm --filter @desyn/docs check:site     # crawls every page from sitemap.xml: 200s, links, anchors, duplicate ids
pnpm --filter @desyn/docs check:search   # Playwright: cmd-K, queries, Enter navigation, Escape
pnpm --filter @desyn/docs screenshots <outDir> [paths…]   # desktop + mobile, dark + light
```

The browser scripts use `playwright-core` with a locally available Chromium (`PLAYWRIGHT_CHROMIUM_PATH`, the newest
cached Playwright headless shell, or `/usr/bin/chromium`); nothing is downloaded.

## Content

- Pages are `content/<slug>.mdx` with `title` and `description` frontmatter. `*word*` in a title renders as the italic
  accent word.
- Sidebar order, labels and prev/next come from `src/lib/nav.ts`. Every nav entry must have a file and vice versa
  (tested).
- Internal links are absolute paths (`/editor/export#print-pdf`); they are checked against real pages and heading ids.
- Components available in MDX: `Callout` (or GitHub alerts `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
  `[!CAUTION]`), `Tabs`/`Tab label`, `Steps` (each `###` inside is a step), `Cards`/`Card`, `Keys combo="mod+shift+z"`
  (platform-aware), `Kbd`, `Badge`, `ArchitectureDiagram`. Code fences accept `title="…"`.

### Generated content

`<Generated name="…" />` is replaced at build time by content generated from a source of truth, so it takes part in
the TOC, search and link checks:

| Name | Source |
| --- | --- |
| `env-vars` (`group`) | `src/data/env.ts` (every variable in SPEC §9; tested against the SPEC) |
| `shortcuts` (`group`) | `src/data/shortcuts.ts` |
| `plan-limits`, `plan-features`, `credit-costs`, `fair-use` | `config/plans.json` |
| `api-endpoints` (`page`, `group`), `api-index`, `api-scopes` | `src/data/api.ts` (scopes tested against `convex/lib/validators.ts`) |
| `model-section` (`section`, `subsection`, `prose`, `shift`) | `docs/DOCUMENT_MODEL.md` sections |
| `model-types` (`names`) | type declarations extracted from `docs/DOCUMENT_MODEL.md`; unknown names fail the build |

## Search

`/search-index.json` is a static route built from the same remark pipeline as the pages (one record per page intro and
per h2/h3 section, with identifiers such as env var names and endpoint paths as keys). The client loads it on first
use and searches it with FlexSearch (`src/lib/search-engine.ts`); open with ⌘K / Ctrl K or `/`.

## Deployment

- Standalone at docs.desyn.app: default build. The Docker image is built by `deploy/docker/next.Dockerfile` with
  `APP=docs` (standalone output is enabled there with `NEXT_PRIVATE_STANDALONE=1`).
- Mounted under desyn.app/docs (Next.js multi-zone): build with `DOCS_BASE_PATH=/docs` (and `DOCS_SITE_URL=https://desyn.app`
  for canonical URLs), then route `/docs` and `/docs/:path*` from the landing app to this deployment:

  ```js
  // apps/landing/next.config.ts
  async rewrites() {
    return {
      // beforeFiles: the landing app has its own app/docs/[[...slug]] fallback page (shown while
      // the docs are down at docs.desyn.app); these rewrites must win over it.
      beforeFiles: [
        { source: "/docs", destination: `${process.env.DOCS_ORIGIN}/docs` },
        { source: "/docs/:path*", destination: `${process.env.DOCS_ORIGIN}/docs/:path*` },
      ],
    };
  }
  ```

  An HTTP proxy in front of both apps (nginx, Caddy) can do the same: route `/docs` and `/docs/*` to the docs
  deployment with the path unchanged.

  basePath is inlined at build time; with `next start` set `DOCS_BASE_PATH` for the start command as well (the
  standalone `server.js` embeds it). Static assets are served under `/docs/_next/…`, so no extra asset rewrite is needed.
  `deploy/docker/next.Dockerfile` does not forward `DOCS_BASE_PATH` as a build argument, so its docs image is always
  the root-path build (docs.desyn.app, or the self-hosting stack's `docs` service on its own hostname).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCS_BASE_PATH` | `""` | Serve under a sub-path such as `/docs` |
| `DOCS_SITE_URL` | `https://docs.desyn.app` | Canonical origin for metadata and the sitemap |
