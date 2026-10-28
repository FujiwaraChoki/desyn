# @desyn/landing

The marketing site for desyn.app: Next.js 16 (App Router, Turbopack), React 19, Tailwind CSS 4, `motion`.
Dark-first "Atmospheric Minimalism, sun edition" (see `docs/DESIGN_SYSTEM.md`).

```bash
pnpm dev          # http://localhost:4102
pnpm build && pnpm start
pnpm typecheck && pnpm test && pnpm lint
pnpm shots        # Playwright screenshots of every page (server must be running) -> shots/review
node scripts/perf.mjs http://localhost:4102/ desktop|mobile   # FCP, LCP, CLS, TBT
```

## What is where

| Path | What |
| --- | --- |
| `app/page.tsx` | Home: hero, live demo, layers explainer, capabilities, templates, platforms, providers, pricing, source-available, FAQ, sunset CTA |
| `components/hero/` | The living sun: CSS sun (first paint, fallback, reduced motion) + lazily started WebGL2 shader (`lib/sun/*`) |
| `components/demo/`, `lib/demo/` | Interactive faux-editor. Pure model (blueprints, edits, prompt matching) is unit-tested |
| `components/layers/LayerStack.tsx` | Scroll-driven exploded 3D layer stack |
| `components/capabilities/` | Six capabilities with CSS-animated vignettes |
| `components/templates/TemplateArt.tsx`, `lib/templates.ts` | Generated SVG template previews (12 layouts); `templates/manifest.json` is used when present |
| `lib/plans.ts` | Reads `config/plans.json` through `@desyn/schema/plans`; every price, limit and feature list on the site comes from it |
| `app/legal/[doc]`, `components/legal/` | Terms, privacy, cookies, licence (renders the real `LICENSE`), DPA. Marked as drafts |
| `app/docs/[[...slug]]` | Calm index pointing at the docs app (`NEXT_PUBLIC_DOCS_URL`); deliberately no redirect (the docs host falls back here) |
| `components/analytics/` | PostHog EU (memory persistence until consent) and DataFast (only after consent), consent banner |
| `lib/og.tsx` | Sun-themed Open Graph images (Instrument Serif from `assets/fonts`) |

## Environment (all optional)

`NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_GITHUB_URL` (GitHub links are hidden
when unset), `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (default `https://eu.i.posthog.com`),
`NEXT_PUBLIC_DATAFAST_WEBSITE_ID`, `NEXT_PUBLIC_DATAFAST_DOMAIN`. Analytics and the consent banner are off when unset.

Security headers are set by nginx (`deploy/nginx`), not here, to avoid duplicates. `output: "standalone"` for the Docker
image (`deploy/docker/next.Dockerfile`, `APP=landing`).
