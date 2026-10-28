# @desyn/editor architecture

The editor is one `EditorController` per open design plus a React shell that lays out **slots**. Feature areas
(canvas interaction, panels, AI, collaboration, export) are **extensions** that fill those slots and register
commands. Nothing in the shell imports a feature directly.

```
                  ┌──────────────────────────── EditorController ────────────────────────────┐
 Convex  ◄──────► │ SyncClient (sync/)          confirmed + pending, rebase, offline queue    │
 designs.load     │   │ change events                                                         │
 designs.commit   │   ▼                                                                       │
 designOps.since  │ store (store/, Zustand)  ◄── selection, tool, viewport, panels, modals     │
                  │   ▲            ▲                                                          │
                  │ History        │ engine view                                               │
                  │ (store/)     EngineBridge (engine-bridge/) ──► @desyn/engine EngineClient   │
                  │ CommandRegistry (commands/) ◄── keyboard (shortcuts/), menus, palette      │
                  │ ExtensionRegistry (shell/extensions.ts) ◄── your extension                 │
                  └───────────────────────────────────────────────────────────────────────────┘
```

## Ownership inside this package

| path | owner |
|---|---|
| `src/{store,sync,commands,shortcuts,shell,engine-bridge}/**`, `src/*.ts(x)`, scaffolding | editor core |
| `src/canvas/**` | canvas interaction agent |
| `src/panels/**` | panels agent (rail flyouts, inspector tabs, pages strip) |
| `src/ai/**` | AI UI agent |
| `src/collab/**`, `src/export/**`, `src/present/**` | collaboration / export agent |

Each feature folder exports one `EditorExtension` from its `index.ts` and adds **one import + one array entry**
to `src/extensions.ts` (`BUILTIN_EXTENSIONS`, append only). Tests go to `test/<area>/*.test.ts(x)`.

```ts
// src/panels/index.ts
import { defineExtension } from "../shell/extensions.ts";
export const panelsExtension = defineExtension({
  id: "panels",
  setup(api) {
    api.registerRailPanel({ id: "layers", label: "Layers", icon: Layers, order: 80, component: LayersPanel });
    api.registerInspectorTab({ id: "design", label: "Design", order: 10, component: DesignTab });
    api.registerSlot("pages", { id: "pages-strip", component: PagesStrip });
    api.registerCommands([...]);
    api.onDispose(() => {/* timers, listeners */});
  },
});
```

## Golden rules

1. **Every document change goes through the controller**: `editor.apply(input, options)` or, for gestures,
   `editor.preview(tx)` per frame + `editor.commitPreview({ label })` on pointer-up. Never commit per frame,
   never write `store.doc` yourself, never call Convex `designs.commit` directly.
2. Build transactions with `@desyn/doc-ops` builders or plain ops. Pass a **builder function** to `apply` when
   it depends on the current state: `editor.apply((design, state) => groupNodes(design, ids))` runs inside the
   edit lock against the freshest view. `DocOpsError`s become a warning toast.
3. One user action = one undo step. Use `coalesceKey` for continuous input (inspector scrubbing `"inspector:x:<ids>"`,
   typing `"text:<nodeId>"`); within 1.2 s the steps merge. AI runs merge by `actor.runId` automatically.
4. Read state with `useEditorStore(selector)` and select **primitives** (or wrap with `useShallow`), never the
   whole state: the viewport changes at frame rate while panning.
5. Selection, page, tool, panels and modals change only through controller methods (`select`, `setPage`,
   `setTool`, `setPanels`, `toggleLeftPanel`, `openModal`...).
6. Respect the mode: `editor.canEdit` / `state.mode` (`edit` | `comment` | `view`). `apply` refuses (with a
   notice) in view / comment mode; hide editing UI there. Extensions can restrict items with `modes: [...]`.
7. User-visible errors: `editor.notify({ kind, title, description })` (toasts). Telemetry:
   `editor.telemetry(event, props)` (no PII; it is forwarded to PostHog by the host).

## Controller API (`src/controller.ts`)

| member | |
|---|---|
| `store`, `getState()`, `design`, `canEdit`, `currentPage()`, `selectedNodes()` | state access |
| `apply(input, { label, history, coalesceKey, normalize, select, selectCreated, source, actor })` | edit; resolves to the doc-ops `ApplyResult` (`applied`, `inverse`, `dropped`) or null |
| `preview(tx, { normalize })` / `commitPreview({ label, ... })` / `cancelPreview()` | live gestures (engine previews; one transaction + one undo step at the end) |
| `undo()` / `redo()` | per-user history (skips steps a collaborator fully overwrote) |
| `select(ids)`, `toggleSelection(ids)`, `clearSelection()`, `setPage(id)` | selection (switches page to the first node's page) |
| `setTool(id, { locked })`, `holdTool(id \| null)`, `tool` | tools (held tool wins: space = hand) |
| `setPanels(patch)`, `toggleLeftPanel(id, open?)`, `openModal(id, props)`, `closeModal()` | chrome |
| `setTextEditing(id \| null)` | text edit mode (also hides nothing by itself: call `engine.setHidden`) |
| `engine` (`EngineBridge`), `engineClient` (`EngineClient \| null`) | rendering, hit tests, snapping, handles, text layout |
| `commands` (`CommandRegistry`), `context()` | commands and when-clause keys |
| `extensions` (`ExtensionRegistry`) | slots |
| `assets` (`AssetService`: `upload(file)`, `urlFor(ref)`), `clipboard` (`insertFiles`, `insertPayload`, `copy`, `paste`) | assets |
| `sync` (`SyncClient`), `backend`, `convex` (`ConvexReactClient \| null`), `share` | backend |
| `navigate(href)`, `notify(n)`, `telemetry(e, p)` | host services |

## Store (`src/store/editor-store.ts`)

`EditorState`: `designId`, `shareToken`, `exitHref`, `permission`, `mode`, `user`, `doc { design, sync }`,
`engine { status, message, painted }`, `selection`, `pageId`, `scopeId` (entered group), `hover`, `tool`,
`heldTool`, `toolLocked`, `viewport { x, y, zoom, width, height }`, `panels` (persisted per user: `left`,
`leftWidth`, `inspectorOpen`, `inspectorWidth`, `inspectorTab`, `pagesOpen`, `aiDock`, `rulers`,
`layoutGrid`, `snapping`, `focusMode`), `modal`, `paletteOpen`, `textEditing`, `renaming`, `compact`,
`history`, `ai { initialPrompt, autoStart, runId }`, `keymap` (user overrides).

`hover` and `renaming` are for the canvas / layers panel: set them with `editor.store.setState({ hover })`.

## Slots (`src/shell/extensions.ts`)

| slot | kind | where / contract |
|---|---|---|
| rail panels | `registerRailPanel` | 68 px rail + 320 px resizable flyout (sheet on phones). Ids with keyboard commands: `layers` (alt+1), `elements` (alt+2), `brand` (alt+3), `pages`, `comments` (shift+c). Planned order: design 10, elements 20, text 30, brand 40, uploads 50, photos 60, ai 70, layers 80, pages 90. The component fills the flyout body below a serif title (scroll inside). |
| inspector tabs | `registerInspectorTab` | right sidebar tabs (Design, Arrange, Effects, Animate, Position). `when(ctx)` hides tabs (e.g. needs a selection). Hidden entirely when no tab applies. |
| `canvas.interaction` | single | absolutely positioned layer over the engine canvas (`inset-0`): pointer events, selection box, handles, hover, tools, text bridge, right-click selection. The canvas region has `data-editor-canvas`. |
| `canvas.overlay` | multi | rulers, guides, layout grid, comment pins, collaborator cursors, AI glow (pointer-events as needed). |
| `canvas.toolbar` | single | floating context toolbar above the selection. |
| `pages` | single | bottom strip under the canvas (toggle `panels.pagesOpen`). |
| `ai.dock` | single | bottom-center stack, above the tool dock (container is `pointer-events-none`; make your root `pointer-events-auto`). Read `panels.aiDock` (`closed` / `bar` / `expanded`), `state.ai` (dashboard handoff: prefill `initialPrompt`; send it only when `autoStart`; follow `runId`), listen to the `desyn:ai-focus` window event (mod+j). Registering it enables the "Ask AI" button and `panel.toggleAiDock`. |
| `topbar.presence` | multi | collaborator avatars (left of zoom). |
| `topbar.actions` | multi | extra top bar buttons. |
| `statusbar` | multi | reserved for small status items. |
| `root` | multi | invisible controllers (presence heartbeat, AI run follower, autosave of versions...). |
| modals | `registerModal({ id, component })` (props type `ModalProps`) | opened with `editor.openModal(id, props)`; the component renders its own `<Dialog open onOpenChange={(o) => !o && close()}>`. Ids the core commands open: `export` (mod+shift+e, top bar Export button), `share` (top bar Share), `save-version` (mod+alt+s), `versions` (mod+alt+h). Each command / button appears once its modal is registered. `shortcuts` is built in. |
| tools | `registerTool` | the core registers select, hand, frame, rect, ellipse, polygon, star, line, arrow, pen, text, comment (`src/commands/tools.ts`); the canvas layer implements what they do (`editor.tool`). |
| context menu | `registerContextMenu([{ command, target, order }])` | entries reference commands (`"-"` = separator). Core orders: clipboard 10-19, z-order 20-29, structure 30-39, transform 40-49, style 50-59, delete 90. Use e.g. order 5 for "Edit with AI…". |

Every slot component receives `{ editor }` and may use the hooks (`useEditor`, `useEditorStore`, `useCommand`).

## Commands (`src/commands/`)

`{ id, label, category, when, run(args, { editor, source, event }), icon, keywords, keys, hidden, checked,
repeat, allowInInput, passThrough }`. Default key bindings live in `src/shortcuts/defaults.ts` (mirrored by
apps/web/lib/shortcuts.ts and the docs; change them together). `useCommand(id)` gives buttons/menus the live
label, enablement, check state and shortcut; `CommandButton`, `CommandMenuItem`, `CommandContextItem` render
them. `commands.run(id, args)` never rejects: a throwing command shows an error toast, reports
`command_failed` telemetry and resolves to `false`. Tab / shift+tab cycle layers only while something is
selected (otherwise they move keyboard focus).

When-clause keys (`computeContext`): `loaded mode canEdit canComment readOnly signedIn isShare hasSelection
selectionCount singleSelection multiSelection selectionType selectionIsPage selectionHasNodes
selectionHasContainer selectionHasGroup selectionHasAutoLayout selectionAllLocked selectionAllHidden
selectionHasText selectionHasImage inScope textEditing tool canUndo canRedo undoLabel redoLabel pageCount
pageIndex hasPrevPage hasNextPage multiplePages zoom modalOpen paletteOpen compact focusMode rulers layoutGrid
snapping inspectorOpen pagesOpen aiDock leftPanel online syncing engineReady clipboardHasContent`.
Grammar: `&& || ! ( )`, `== != > >= < <=` with quoted strings / numbers.

Built-in ids: `history.undo|redo`, `edit.delete|duplicate|group|ungroup|frameSelection|autoLayout|useAsMask|
flipHorizontal|flipVertical|toggleLock|toggleVisibility|rename|copyStyle|pasteStyle|nudge{Left,Right,Up,Down}[Big]`,
`edit.copy|cut|paste|pasteInPlace|copyAsPng|copyText`, `selection.selectAll|clear|enter|parent|next|previous|matching`,
`arrange.align{Left,Center,Right,Top,Middle,Bottom}|distributeHorizontal|distributeVertical|tidy|matchWidth|
matchHeight|bringForward|sendBackward|bringToFront|sendToBack`, `view.zoomIn|zoomOut|zoomTo|zoom100|zoomFit|
zoomSelection|toggleRulers|toggleLayoutGrid|toggleSnapping|toggleFocusMode`, `page.add|duplicate|delete|moveUp|
moveDown|next|previous|goto` (args `{ pageId }`), `tool.<id>`, `tool.image`, `panel.layers|elements|brand|
pagesList|comments|open|toggleInspector|togglePages|toggleAiDock|versions`, `file.saveVersion|export|
downloadPng|share|copyLink|present|rename|exit`, `help.commandPalette|shortcuts`.

**Text formatting shortcuts** (mod+b/i/u, alignment while editing) belong to the text bridge of the canvas
layer; the core commands are disabled while `textEditing` is set.

## Sync (`src/sync/`)

DOCUMENT_MODEL §6 exactly: paginated load (re-read when pages disagree), `confirmed` + `pending`,
`designs.commit` with `baseSeq` one at a time, idempotent retries (same `tx.id`), echoes as acks, acks for a
later seq wait for the echo, rebase of pending over remote transactions with doc-ops, gap -> reload keeping
pending work, offline queue in IndexedDB (per user), rejected transactions rolled back and reported,
transactions above 1500 ops / 600 KB split into ordered chunks, conflict telemetry (`sync_conflict`). Events:
`change` (`cause`: load / local / remote / ack / rollback / reload; `remote` + `remoteInverses` list the
foreign transactions folded in, with their inverses), `status`, `conflict`, `rejected`. Connection state =
browser network (`online` / `offline` events, immediate) and the Convex socket; reconnecting runs every waiting
retry (commit, re-subscription, reload) at once.

History: own edits are recorded by `apply` / `commitPreview`. Remote transactions prune the stacks (undo never
reverts a collaborator's newer value), except the user's own server-run AI / workflow transactions
(`source` ai | workflow, `actor.userId` = the signed-in user, `actor.runId` set; `designs.commitAs` writes
`actor.userId`): those are recorded and merge into one undo step per run.

## Engine bridge (`src/engine-bridge/`)

One `EngineClient` per editor, created when `<EngineViewport/>` mounts a fresh canvas. Local edits are
normalized by the engine (layout, text boxes) before they reach the sync client; remote changes are applied
linearly or by structural diff; loads / reloads reload the engine. Assets resolve through signed URLs
(`AssetService`), fonts through the engine's FontLoader. The bridge follows `pageId`, mirrors the engine view
into `store.viewport`, sets the pasteboard color per theme, and commits engine relayouts (after font loads) as
`system` transactions without undo steps. Wheel / trackpad pan and pinch / ctrl+wheel zoom live in
`EngineViewport`; everything pointer-based is the `canvas.interaction` slot.

Canvas layer recipe: `editor.engineClient?.hitTestScreen(p)`, `.marquee`, `.snap`, `.handles`, `.resizeBox`,
`.rotationDelta`, `.screenToPage`; drags call `editor.preview(tx)` per pointer move and
`editor.commitPreview({ label: "Move" })` on pointer-up; text editing uses `TextEditBridge` with
`onCommit: (tx) => editor.apply(tx, { coalesceKey: \`text:${id}\` })`, `editor.setTextEditing(id)` and
`editor.engine.setHidden([...])` as needed.

## Backend access for extensions

`editor.convex` is the app's `ConvexReactClient` (null in tests); components can also use `convex/react` hooks
(the host provides `<ConvexProvider>`). Reference functions by name with `makeFunctionReference` (see
`src/sync/convex-transport.ts`) so the package does not depend on the app's generated API, and pass
`editor.share` as the `share` argument so share-link sessions work.

## Testing

`test/fake-server.ts` (`FakeServer`, `FakeTransport`: scripted commit timing, lost responses, failures,
dropped subscriptions, compaction; the log's `actor.userId` is the committing user as on Convex),
`test/fake-engine.ts` (`FakeEngine`: an in-memory EngineClient stand-in with `gate()` to hold an apply,
`failNext`, preview / commitPreview) and `test/editor-helpers.ts` (`createTestEditor(design, { engine })` ->
controller on the fake backend as user `user1`; pass `{ engine: { createClient: fakeEngineFactory(new
FakeEngine()) } }` and call `editor.engine.attach(document.createElement("canvas"), () => editor.design)` for
an engine). `pnpm --filter @desyn/editor test` (vitest + jsdom + fake-indexeddb).

## Collaboration, export, present (`src/collab`, `src/export`, `src/present`)

- Backends are interfaces (`CollabBackend`, `ExportBackend`) built from `editor.convex` by default; hosts and
  tests pass their own with `createCollabExtension({ backend })` / `createExportExtension({ backend })`. Without
  a Convex client collaboration stays off and exports run in the browser only.
- The **comment tool** (`tool.comment`, key c) is handled by the comment pins overlay, not by the canvas layer.
  Overlays that take pointer input mark themselves `data-canvas-chrome` (the canvas controller ignores those
  events).
- Comment anchors: `x`, `y` are page coordinates, or the anchored layer's own box coordinates when `nodeId` is
  set (`anchorAt` / `resolvePin` in `src/collab/comments/anchor.ts`).
- `present.start` (mod+alt+enter) presents in place; `file.present` still opens `/present/[id]`, which can
  render `PresentDesign` from this package.

