# @desyn/editor

The Desyn editor for the web: document store, Convex sync client, undo / redo, commands, keyboard shortcuts,
the engine bridge and the editor shell (top bar, rail + flyout, canvas, inspector, pages strip, tool dock, AI
dock) with slots that feature extensions fill. Architecture and extension contract: [ARCHITECTURE.md](./ARCHITECTURE.md).

```tsx
import { Editor } from "@desyn/editor";

// Client-only, under <ConvexProvider> (or pass `convex` / `backend`) and @desyn/ui's <DesynProvider>.
<Editor designId={id} exitHref="/" shareToken={token} initialPrompt={prompt} autoStartPrompt={auto} runId={run} />;
```

apps/web mounts it at `/design/[id]` (`components/editor/editor-mount.tsx`, alias in `next.config.ts`). The app's
global CSS imports `packages/editor/src/styles.css` so Tailwind generates the editor's utilities.

## Features

- **Sync** (DOCUMENT_MODEL §6): chunked load, `confirmed` + `pending`, commits with `baseSeq`, reactive
  `designOps.since`, rebase via `@desyn/doc-ops`, idempotent retries with backoff, offline queue in IndexedDB,
  reconnect, gap reload, conflict telemetry, read-only / comment modes for share links.
- **History**: inverse transactions, coalescing (drags, nudges, scrubs, AI runs), per-user stacks that never
  revert collaborators' newer values. The user's own server-run AI / workflow transactions (they arrive through
  `designOps.since` with `actor.userId` = the user and an `actor.runId`) are undoable, one step per run.
- **Commands**: About 100 commands with when-clauses (selection, clipboard, group / ungroup, frame, auto layout, mask,
  align / distribute / tidy / match size, z-order, lock / hide / flip, nudge, zoom / fit, pages, present, export,
  share, versions, panels, tools), command palette (commands, pages, layers), app menu, context menus.
- **Clipboard**: system clipboard with Desyn JSON (custom MIME + HTML flavour), images (uploaded to the
  workspace), SVG (vector layers), plain text; paste in place, paste into a selected frame, copy as PNG, drop
  files on the canvas.
- **Shortcuts**: Figma / Canva-familiar defaults, per-OS display, physical-key matching for shifted keys,
  customizable in the shortcuts dialog (mod+/), stored in the user's profile (`editor/prefs`).
- **Engine bridge**: one `EngineClient` per editor, normalization of edits, asset URLs, page following,
  view mirroring, theme pasteboard, relayout commits, wheel / pinch navigation.
- **Shell**: resizable panels remembered per user (localStorage + profile), sheets on phones, focus mode,
  sync status, mode badge, loading / error screens, dark-first with a designed light mode.
- **Collaboration** (`src/collab`): live cursors, selections and "typing" markers of others, avatar stack with
  follow mode, comments (pins anchored to layers or points, threads panel with filters and search, replies,
  @mentions with autocomplete, resolve, unread badge), share dialog (members and invites, links with
  permission / password / expiry, embed code), version history (named + autosaved versions, read-only preview
  on the canvas, restore, naming).
- **Export / import** (`src/export`): PNG / JPG / WebP / SVG / PDF / PDF Print / PowerPoint / GIF / MP4 with pages,
  scale or width, quality, transparency, PDF resolution, bleed / crop marks / CMYK and frame rate; small exports
  render in the browser, large ones and video as server jobs with progress and e-mail; plan-gated formats.
  Import of SVG, images, PDF pages, PowerPoint slides, `.desyn` archives and Design JSON.
- **Present** (`src/present`): full-screen slides with transitions and the document's animations, clicker /
  keyboard navigation, black / white screens, overview, presenter view (notes, timer, clock, next slide);
  `Presenter` / `PresentDesign` for apps/web `/present/[id]`.

## Develop

```sh
pnpm --filter @desyn/editor typecheck
pnpm --filter @desyn/editor lint
pnpm --filter @desyn/editor test          # vitest: sync (fake Convex with scripted concurrency), history,
                                          # engine bridge (fake engine), commands, clipboard, shortcuts,
                                          # Convex transport connection state, shell rendering
```

Browser harness for collaboration / export / present (real engine, scripted backends, port 4107):
`../ui/node_modules/.bin/vite --config test/harness/vite.config.ts`, then open http://127.0.0.1:4107/
(`?still=1` stops the scripted cursors, `?theme=light`; `window.__harness` exposes `present()` and
`importPptx()`).

In the app: run the local Convex and `apps/web` dev server (apps/web/README.md "Develop"), sign up, create a
design and open it.
