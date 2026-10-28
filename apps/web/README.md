# @desyn/web — app.desyn.app

Next.js 16 (App Router, Turbopack) app on port 4100: auth, onboarding, dashboard, templates, brand kits,
settings, admin, share/present pages and the client-only editor route. UI is built from `@desyn/ui` +
`@desyn/tokens`; data comes from Convex (`convex/_generated/api`, imported as `@convex/_generated/api`).

## Routes

| Route | What it is |
| --- | --- |
| `/login`, `/signup`, `/verify`, `/magic`, `/forgot`, `/reset` | Better Auth flows (email + password with verification, magic link, reset, Google/GitHub when configured). `?next=` is honoured and validated (`lib/routes.ts#safeNext`). `/signup?plan=pro&interval=year` and `?template=<slug>` are remembered and finished after onboarding. |
| `/onboarding` | What you make + role, team workspace with invites, brand kit quick setup, ready. |
| `/` | Greeting, "describe a design" AI prompt, format presets (+ custom size, all 130+ formats), folders, recent designs. |
| `/projects`, `/projects/[folderId]` | Folder tree with drag and drop (designs onto folders, folders into folders), breadcrumbs, search. |
| `/templates` | Search, format filter, categories, collections, favorites, preview modal, use template. |
| `/brand` | Brand kits: logos (upload), palette with roles, fonts (catalog + on-demand Google Fonts preview), voice, rules. |
| `/shared`, `/trash` | Shared with me; trash with restore / delete forever. |
| `/settings/{profile,workspace,members,billing,usage,ai,api-keys,appearance,shortcuts}` | Account and workspace settings; Stripe Checkout/Portal; BYOK keys and per-task models; API keys. |
| `/admin` | Admin console (users, plan overrides, credits, flags, health, integrations). |
| `/design/[id]` | Mounts `@desyn/editor`'s `<Editor/>` client-only (see below). |
| `/present/[id]` | Fullscreen presenter (slides rendered by the render worker, keyboard/touch, grid, blackout). |
| `/share/[token]` | Share links: password gate, preview, open in editor (view/comment/edit), present. |
| `/accept/[invite]`, `/native/authorize` | Workspace invites; desktop/iOS/CLI PKCE sign-in approval. |
| `/api/auth/*` | Proxy to Better Auth on the Convex site URL (cookies first-party). |
| `/api/vitals`, `/api/ai/models` | Web Vitals to Axiom (when configured); public AI model catalogs (server-fetched). |

## Editor contract

`/design/[id]` lazily imports `@desyn/editor` after mount and renders `<Editor {...EditorProps} />`
(`lib/editor-contract.ts`: `designId`, `shareToken?`, `initialPrompt?`, `autoStartPrompt?`, `runId?`, `exitHref`).
`initialPrompt` comes from `?prompt=` and is prefill only; `autoStartPrompt` is true only when this tab's dashboard
handed the prompt over (`lib/prompt-handoff.ts`), so a crafted link can never run the agent without a click. `@desyn/editor`
is a regular workspace dependency (transpiled by Next with `@desyn/engine` and the other internal packages).

## Develop

```sh
# local anonymous Convex (needs Node 24 for "use node" actions), from the repo root:
flock /tmp/desyn-convex.lock env PATH=$HOME/.local/share/mise/installs/node/24.13.1/bin:$PATH \
  CONVEX_AGENT_MODE=anonymous npx convex dev --tail-logs always --typecheck disable > /tmp/convex.log 2>&1 &
npx convex env set APP_URL http://localhost:4100      # once: auth links and trusted origin
cd apps/web
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3212 NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3213 pnpm dev
```

The local deployment uses `MAIL_TRANSPORT=log`: verification, magic and reset links appear in the Convex log.

## Checks

```sh
pnpm typecheck && pnpm lint && pnpm test           # tsc, biome, vitest (lib/*.test.ts)
pnpm build                                          # next build (output: standalone)
# end to end against a production server and the local Convex above:
pnpm build && pnpm start &
E2E_CONVEX_LOG=/tmp/convex.log pnpm e2e             # Playwright (chromium), offline
E2E_CONVEX_LOG=/tmp/convex.log node scripts/seed-session.mjs http://localhost:4100 /tmp/state.json
node scripts/screenshots.mjs http://localhost:4100 shots --state /tmp/state.json / /projects /templates /brand
```

## Environment

See `.env.example`. Everything `NEXT_PUBLIC_*` is build time. Security headers (CSP, XFO, HSTS on https) are
set by `next.config.ts` unless `DESYN_SECURITY_HEADERS=off`.
