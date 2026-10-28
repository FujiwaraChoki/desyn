# Desyn desktop — architecture and extension API

The desktop app (`apps/desktop`, crate `desyn-desktop`, binary `desyn`) is a native GPUI editor over the shared Rust
engine. It links `desyn-core` (model, transactions, hit testing, snapping, arrange, clipboard), `desyn-text` (shaping,
caret geometry, real text metrics for layout) and `desyn-raster` (the renderer every client shares) directly, renders
the page into GPU textures and draws the editor chrome with GPUI.

This document is for the people and agents who build on the shell: feature modules (layers / elements / brand panels,
inspector, AI dock, sync with Convex, export, comments, versions, presenter) plug in through `ui::ext` without editing
the shell.

## 1. Layers

```
src/
  doc/          pure: an open design (Document), undo history, previews, editing commands, import, clipboard payloads
  file/         pure: the .desyn archive, thumbnails, library scan, recent files, crash recovery
  canvas/       pure: the canvas view model (EditorSession) — camera, tools, gestures, snapping, pen, text editing,
                overlay geometry, rulers, the raster tile cache
  ui/           GPUI: app startup, windows, workspace (title bar, tabs, menus), editor view, canvas element, tool dock,
                pages strip, start screen, palette, settings, shortcuts, theme, icons, extension API, scripting
  deeplink.rs   launch requests: arguments, file associations, desyn:// links
  ipc.rs        single-instance handoff (second launches forward their arguments)
  settings.rs   settings.json (unknown keys preserved; feature modules store state under `extensions`)
  paths.rs      config / data / library directories (`DESYN_HOME` relocates everything), atomic writes
  presets.rs    page sizes generated from @desyn/schema (`scripts/gen-presets.mjs`)
```

Everything outside `ui/` is UI-free and unit-tested (`cargo test`), including complete user flows through
`EditorSession` (`tests/session.rs`: draw, select, move with snapping, resize with shift / alt, rotate with 15° steps,
marquee, alt-duplicate, group / ungroup, text typing / IME / formatting, pen drawing and point editing, ruler guides,
clipboard, image placement, zoom / pan / pinch, pages, tiles).

## 2. Data flow

```
pointer / keys / IME ──► EditorView (actions, key contexts) ──► EditorSession
                                                                   │  gestures: Document::set_preview(ops) every move
                                                                   │  pointer-up / Enter / Escape: one transaction
                                                                   ▼
                                                     Document::apply → desyn_core::apply_transaction(normalize, desyn-text)
                                                                   │  history (inverse tx), revision++, Change{applied}
                                                                   ▼
          EditorView::after(): EditorEvent::{Changed, Selection, Page, …} ──► workspace (tabs, toasts)
                                                                   │                      ──► ext observers (sync, panels)
                                                                   ▼
                    canvas prepaint: TileCache::sync (display list, damage) → render tiles within a frame budget
                                     → BGRA textures → paint_image; overlay prims painted on top
```

* **One transaction per gesture** (DOCUMENT_MODEL §6). Drags, resizes, rotations, guide moves, pen edits and typing
  run as *previews*: `Document::set_preview` reverts the previous preview and applies the new ops, so the canvas
  shows the exact result every frame while history and listeners see nothing until the gesture ends.
  `Document::apply_external` re-applies a running preview on top of a remote change, so a collaborator's edit never
  cancels your drag.
* **Typing** commits a checkpoint after 400 ms without keystrokes (DOCUMENT_MODEL §6) while the layer stays in
  edit mode (`EditorSession::checkpoint_text`), so sync sees text as it is typed; all checkpoints of one editing
  session plus its final commit are one undo step. IME compositions are never committed half-way.
* **Undo** uses the core's exact inverse transactions (`doc::history`). Consecutive nudges coalesce into one step;
  undoable external transactions with the same `actor.runId` (one AI run) group into one step with no time limit.
* **Dirty state** counts committed changes only (`Document::save_point` / `mark_saved`); live previews and
  cancelled gestures never mark a design unsaved.
* **Derived geometry** (auto-layout, group bounds, text auto-resize) is computed by the core with desyn-text as the
  measurer, and reported in `applied`. Commit `Change.tx.ops` (the applied ops) to Convex, not the raw ops.
* **Rendering**: `canvas::tiles::TileCache` builds the page's display list with desyn-raster (incremental: unchanged
  nodes reuse cached paint), keeps 256 × 256 device-pixel tiles anchored at the page origin (panning reuses them),
  marks only damaged regions after an edit (`display::damage`), renders visible tiles nearest the viewport center
  first within a 6 ms (interacting) / 14 ms (idle) budget, and keeps the previous zoom level as a scaled stand-in
  until the new level is complete. Device scale = window scale factor (HiDPI). Texture uploads and retirements are
  tracked by tile uid (`EditorView::tile_images`).
* **Text** is edited in place: the session edits the runs, previews them, and the renderer draws them (so typing
  shows exactly what exports). Caret / selection / IME geometry comes from desyn-text (`LaidOutText`); the canvas
  element registers GPUI's input handler while editing, so composition (CJK, dead keys) and the character palette
  work.

## 3. The editor API (for feature modules)

`ui::editor::EditorView` (a GPUI entity, one per open design):

| member | use |
|---|---|
| `session: EditorSession` | the view model: `doc.design` (desyn-core `Design`), `doc.assets` (bytes by asset id), `selection`, `page`, `camera`, `tool`, `prefs`, `renderer` (desyn-raster, also the text measurer) |
| `apply(ops, label, cx) -> bool` | apply ops as one undoable step (inspector edits, AI tools run locally) |
| `apply_external(&tx, undoable, cx) -> bool` | apply a transaction from sync / an AI run (`undoable: true` for the user's own AI run so it undoes as one step) |
| `add_asset(bytes, AssetRef) -> (id, ops)` | store image / font bytes (sha256-deduplicated); include the returned `asset` op in your transaction |
| `select(ids, cx)`, `set_page(id, cx)` | drive selection and page |
| `render_page_png(page, scale)` | PNG of a page (AI previews, sharing) |
| `set_activity(ids, cx)` / `flash(ids, cx)` | AI feedback: pulsing sun glow while working, fading "sunrise" when done (DESIGN_SYSTEM §4) |
| `file()`, `name()`, `is_dirty()`, `key()` | document identity |
| `save(window, cx)`, `save_as(window, cx)`, `save_to(path, user, cx)` | file operations (background write; thumbnails render on a shared background renderer) |
| `write_now(cx)`, `save_for_close(window, cx) -> Task<bool>`, `flush(cx)`, `discard_recovery(cx)` | closing paths: synchronous write; save (Save As when untitled) resolving to whether it reached disk; autosave + fresh recovery snapshot; drop the snapshot after "Don't Save" |
| `start_link_edit(window, cx)` | the text link field (mod+shift+U while typing; `canvas::text::normalize_link` refuses `javascript:` / `data:` and other schemes) |
| `import_paths(paths, at, cx)` | import files at a canvas point |
| `toggle_left_panel(id, cx)`, `toggle_inspector(cx)` | panel visibility |

`EditorView` emits `EditorEvent`: `Changed(Vec<Change>)` (each `Change { kind: Edit | Undo | Redo | External, tx }`
with the applied ops), `Selection(ids)`, `Page(id)`, `Saved(path)`, `TitleChanged`, `Notice(text)`,
`TextEditing(bool)`, `OpenFile(path)`.

Lower level, without GPUI: `canvas::EditorSession` exposes every editing command (`group`, `align`, `reorder`,
`duplicate`, `paste_text`, `paste_bytes`, `edit_text`, `edit_path`, `add_page`, …) and `doc::edit` the same commands
as pure op builders over a `Design`.

## 4. Extension API (`ui::ext`)

Feature modules register from an installer passed to `ui::run` in `src/main.rs`:

```rust
fn main() {
    desyn_desktop::ui::run(vec![Box::new(layers::install), Box::new(sync::install), Box::new(export::install)]);
}

pub fn install(cx: &mut gpui::App) {
    use desyn_desktop::ui::{actions, ext::*};
    Extensions::update(cx, |x| {
        // A left-rail panel with a 320 px flyout (Slot::Right = inspector column, Slot::Dock = AI prompt bar).
        x.panel(PanelSpec::new("layers", "Layers", "icons/layers.svg", Slot::Left, |editor, window, cx| {
            cx.new(|cx| LayersPanel::new(editor.clone(), window, cx)).into()
        }).order(80));
        // Make a shell action work (shortcut, menu entry and palette entry appear once handled).
        x.handle::<actions::LayersPanel>(|editor, _window, cx| {
            editor.update(cx, |e, cx| e.toggle_left_panel("layers", cx))
        });
        x.handle::<actions::Export>(|editor, window, cx| open_export_dialog(editor, window, cx));
        // Observe every editor (sync commits Change.tx; autosave mirrors; analytics).
        x.on_document(|editor, event, cx| {
            if let desyn_desktop::ui::editor::EditorEvent::Changed(changes) = event { sync::commit(editor, changes, cx) }
        });
        // Palette commands, top bar items (share button, collaborators, AI button), deep links.
        x.command(CommandSpec { /* id, title, group, keywords, run */ });
        x.top_bar(10, |editor, window, cx| share_button(editor, window, cx));
        x.on_cloud_link(|design_id, cx| sync::open_cloud_design(design_id, cx));
        x.on_auth_callback(|params, cx| account::finish_native_sign_in(params, cx));
    });
}
```

Shell actions reserved for modules (their shortcuts match the web): `Export` (mod+shift+E), `SaveVersion`
(mod+alt+S), `OpenAiPrompt` (mod+J), `ToggleInspector` (mod+alt+I; toggles the right column when unhandled),
`LayersPanel` / `ElementsPanel` / `BrandPanel` (alt+1/2/3), `Comments` (shift+C), `CommentTool` (C),
`VersionHistory` (mod+alt+H),
`Present` (mod+shift+enter). Unhandled actions are hidden from menus and the palette and show an explanatory toast
when their shortcut is pressed.

Icons: panels name an icon path; add the Lucide icon name to `scripts/gen-icons.mjs` and rerun it (icons are
embedded at build time by `build.rs`).

Settings: store module state in `Settings::extensions["<module>"]` (`ui::app::AppState::update(cx, |s| …)` then
`s.save_settings()`); unknown keys survive upgrades.

## 5. Sync guidance (for the sync module)

* Local edits: on `EditorEvent::Changed`, commit `Change.tx` (applied ops, fresh id) with `designs.commit` (JSON wire
  format, `convex/lib/designs_wire.ts`); `ChangeKind::External` changes came from you (skip them).
* Remote transactions (`designOps.since`): `EditorView::apply_external(&tx, false, cx)`; the session reconciles
  selection, page, text and pen sessions automatically.
* Assets: `AssetRef.storageKey` of local assets is `assets/<id>.<ext>` (the path inside the .desyn file). Upload the
  bytes from `session.doc.assets` and rewrite the key with an `asset` op when the server assigns its S3 key; bytes
  for remote assets go into `session.doc.assets` + `session.sync_assets()`.
* Cloud designs open via `desyn://design/<id>` → `on_cloud_link`; create an `EditorView` from the loaded `Design`
  (`Document::new(design, assets)`) and add it with `Workspace::open_document(doc, None, window, cx)`.

## 6. Files

`.desyn` = zip: `mimetype` (stored, first: `application/x-desyn`), `manifest.json` (format version, app, design id /
name / kind, pages with sizes, sha256 of the canonical design, thumbnails), `design.json` (canonical JSON, the source
of truth), `assets/<id>.<ext>`, `thumbnails/cover.png` (512 px) and `thumbnails/<pageId>.png` (256 px). Reads are
zip-bomb checked; unknown entries are ignored; designs from newer versions keep their unknown keys.

New designs are created directly in the library folder (`~/Documents/Desyn`, configurable) and autosave after
1.5 s of idle (never mid-gesture). Crash recovery snapshots unsaved designs every 10 s into a locked session folder;
the start screen offers sessions whose lock is free (a crash or kill) for recovery.

## 7. Windows, menus, keys

* Closing: a tab, a window (`Workspace::confirm_close -> Task<bool>`) and Quit (`ui::workspace::quit`, every
  window in turn) ask Save / Don't Save / Cancel for designs that autosave cannot cover, and only close once the
  chosen saves reached disk (a cancelled Save As keeps the tab). On Linux the dialogs are drawn by `ui::prompt`
  (Desyn style); macOS and Windows use their native alerts.
* Each window is a `ui::workspace::Workspace`: title bar (menus drawn in-window on Linux / Windows, native menu bar
  on macOS; tabs; window controls with client-side decorations), the start screen and one `EditorView` per tab.
  Tabs move between windows (Window > Move tab to new window).
* Key contexts: `Workspace` > `Editor` > `Canvas` (not typing) / `TextEditing` (typing) / `TextField`. Shortcuts are
  the web editor's (`ui/actions.rs`, docs shortcut table); `secondary` = ⌘ on macOS, Ctrl elsewhere.
* Commands (`ui/commands.rs`) feed the palette, menus and the shortcuts sheet.

## 8. Testing and automation

* `cargo test`: unit tests for every pure module plus `tests/session.rs`.
* `DESYN_SCRIPT` drives the real app through GPUI's input dispatch (see `src/ui/script.rs`), e.g.
  `DESYN_SCRIPT="new:instagram-post;tool:rect;drag:500,250,700,400;key:secondary-d"`. Combined with a headless
  Wayland compositor and `grim`, this is how the UI was verified (README, "Screenshots").
