# Desyn desktop

Native desktop editor for Desyn, built with GPUI on top of the shared Rust engine (`desyn-core`, `desyn-text`,
`desyn-raster`). Architecture and the extension API for feature modules: [`ARCHITECTURE.md`](ARCHITECTURE.md).

What is here: windows with tabs, native / in-window menus (File, Edit, View, Insert, Arrange, Window, Help), the web
editor's keyboard shortcuts, command palette (mod+K), shortcuts sheet (mod+/), dark / light / system themes, settings,
a local library of `.desyn` files (open, save, save as, recent files, autosave, crash recovery, import of SVG / images /
JSON, drag and drop), file associations and `desyn://` links, and the canvas: tiled raster rendering with damage
tracking and HiDPI, pan / zoom (trackpad, wheel, pinch, space-drag), selection, multi-select, marquee, transform
handles (shift keeps proportions, alt resizes from the center, rotate with 15° steps), snapping with guides, equal
spacing and smart distances, rulers and guides, layout and pixel grids, nudging, the tool dock (select, frame,
rectangle, ellipse, polygon, star, line, arrow, pen with bezier point editing, text with IME, image placement, hand),
undo / redo, copy / paste (Desyn clipboard JSON shared with the web editor, images, SVG, text) and the pages strip.

## Build and run

```sh
export CARGO_TARGET_DIR=$PWD/target/desyn-desktop CARGO_BUILD_JOBS=6   # from the repo root
cargo run -p desyn-desktop                     # debug
cargo build --release -p desyn-desktop         # target/desyn-desktop/release/desyn
cargo test -p desyn-desktop                    # unit + view-model tests (offline)
cargo clippy -p desyn-desktop --all-targets -- -D warnings && cargo fmt -p desyn-desktop --check
```

GPUI is `gpui-pre 0.3.9` from crates.io (Zed's gpui published at zed@93d7456; the official `gpui` 0.2.2 needs a
libc downgrade). Linux needs the usual Wayland / X11 / Vulkan development packages (`libxkbcommon`, `wayland`,
`libxcb`, `vulkan-icd-loader`, `fontconfig`, `freetype2`); software rendering via Mesa lavapipe works.

Command line: `desyn [file.desyn | image | svg | json | desyn://…]…`, `desyn --version`,
`desyn --write-icons <dir>` (renders the app icon sizes for packaging).

## Environment

| variable | effect |
|---|---|
| `DESYN_HOME` | put config, data and the library below this folder (portable installs, tests) |
| `DESYN_LIBRARY` | library folder for this run |
| `DESYN_LOG` | `error` / `warn` (default) / `info` / `debug` / `trace` |
| `DESYN_MULTI_INSTANCE` | do not hand off to an already running instance |
| `DESYN_SCRIPT` | drive the app (`src/ui/script.rs`), e.g. `new:instagram-post;tool:rect;drag:500,250,700,400` |
| `DESYN_EXIT_AFTER_MS` | quit after a delay (smoke tests) |

Files: settings `~/.config/desyn/settings.json` (macOS `~/Library/Application Support/Desyn`), recent files
`recent.json` next to it, recovery snapshots `~/.local/share/desyn/recovery`, library `~/Documents/Desyn`.

## File associations and deep links

`.desyn` files have the MIME type `application/x-desyn` (a zip whose first, stored entry is `mimetype`). Links:
`desyn://open?path=<absolute path>`, `desyn://new[?preset=<id>|w=<px>&h=<px>&kind=<kind>&name=<text>]`,
`desyn://design/<id>` (cloud, handled by the sync module), `desyn://auth/callback?code=…&state=…` (native sign-in),
`desyn://settings`. Second launches forward their arguments to the running app (Unix socket, or a token-protected
loopback port on Windows), so opening files and links reuses the open window.

* **Linux**: `packaging/linux/install.sh [path/to/desyn]` installs the binary to `~/.local/bin`, the desktop entry
  `app.desyn.Desyn.desktop` (`MimeType=application/x-desyn;x-scheme-handler/desyn;`), the shared-mime-info file
  `app.desyn.Desyn.xml` (glob + magic), icons in all hicolor sizes, refreshes the databases and sets Desyn as the
  default handler with `xdg-mime`. System packages ship the same files under `/usr/share`.
* **macOS**: `packaging/macos/bundle.sh` (run on a Mac) builds `Desyn.app` with `packaging/macos/Info.plist`:
  exported UTI `app.desyn.design` (conforms to `public.zip-archive`, extension `desyn`), `CFBundleDocumentTypes` (owner
  of `.desyn`, alternate viewer for SVG / PNG / JPEG / WebP) and `CFBundleURLTypes` for `desyn`. Finder opens and
  links arrive through GPUI's open-URLs handler.
* **Windows**: `packaging/windows/desyn.reg` registers `.desyn` (`Desyn.Design`, open command `"desyn.exe" "%1"`) and
  the `desyn` URL protocol per user; installers write the same keys with the installed path.

## Screenshots (headless verification on Linux)

```sh
X=/tmp/dsx; mkdir -p $X && chmod 700 $X
printf 'output HEADLESS-1 resolution 1600x1000 scale 1\ndefault_border none\n' > $X/sway.conf
env -u DISPLAY -u WAYLAND_DISPLAY XDG_RUNTIME_DIR=$X WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
  WLR_RENDERER=pixman sway -c $X/sway.conf &
env -u DISPLAY XDG_RUNTIME_DIR=$X WAYLAND_DISPLAY=wayland-1 DESYN_HOME=/tmp/desyn-shot DESYN_MULTI_INSTANCE=1 \
  DESYN_EXIT_AFTER_MS=8000 DESYN_SCRIPT="new:instagram-post;wait:600;tool:rect;drag:520,120,760,300;click:600,200" \
  target/desyn-desktop/debug/desyn &
sleep 5; XDG_RUNTIME_DIR=$X WAYLAND_DISPLAY=wayland-1 grim shot.png
```

## Regenerated assets

* `assets/icons/*.svg` — `node apps/desktop/scripts/gen-icons.mjs` (Lucide, ISC).
* `assets/presets.json` — `node apps/desktop/scripts/gen-presets.mjs` (from `@desyn/schema` `PAGE_PRESETS`).
* `assets/fonts` — Instrument Sans / Serif and JetBrains Mono (SIL OFL, licenses in `assets/fonts/licenses`).
