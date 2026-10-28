// Regenerates assets/icons/*.svg from the Lucide icon data shipped with lucide-react (ISC license).
// Usage (repo root): node apps/desktop/scripts/gen-icons.mjs
// The desktop app draws icons as monochrome masks (gpui `svg()`), so every icon is written with a black
// 1.5 px stroke on a 24 px grid (DESIGN_SYSTEM.md section 5: Lucide, 1.5 px stroke).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets", "icons");
const store = join(here, "..", "..", "..", "node_modules", ".pnpm");
const pkg = readdirSync(store)
  .filter((d) => d.startsWith("lucide-react@"))
  .sort()
  .pop();
if (!pkg) throw new Error("lucide-react is not installed (pnpm install at the repo root)");
const iconsDir = join(store, pkg, "node_modules", "lucide-react", "dist", "esm", "icons");

const ICONS = [
  "mouse-pointer-2",
  "frame",
  "square",
  "circle",
  "pentagon",
  "star",
  "minus",
  "move-up-right",
  "pen-tool",
  "type",
  "link",
  "image",
  "hand",
  "undo-2",
  "redo-2",
  "zoom-in",
  "zoom-out",
  "search",
  "command",
  "plus",
  "x",
  "chevron-down",
  "chevron-right",
  "chevron-left",
  "chevron-up",
  "file",
  "file-plus",
  "folder-open",
  "save",
  "download",
  "upload",
  "copy",
  "clipboard-paste",
  "trash-2",
  "sun",
  "moon",
  "monitor",
  "settings",
  "layers",
  "panel-left",
  "panel-right",
  "grid-3x3",
  "ruler",
  "magnet",
  "maximize",
  "minimize-2",
  "app-window",
  "copy-plus",
  "ellipsis",
  "check",
  "clock",
  "history",
  "lock",
  "lock-open",
  "eye",
  "eye-off",
  "group",
  "ungroup",
  "keyboard",
  "info",
  "triangle-alert",
  "file-image",
  "file-json",
  "scan",
  "maximize-2",
  "message-square-text",
  "home",
  "library-big",
  "rotate-cw",
  "flip-horizontal-2",
  "flip-vertical-2",
  "bring-to-front",
  "send-to-back",
  "files",
  "file-up",
  "align-start-vertical",
  "align-center-vertical",
  "align-end-vertical",
  "align-start-horizontal",
  "align-center-horizontal",
  "align-end-horizontal",
  "external-link",
  "refresh-cw",
  "life-buoy",
  "scissors",
  "squares-unite",
  "spline",
  "text-cursor-input",
  "move",
  "grip-vertical",
  "circle-alert",
  "folder",
  "file-clock",
  "layout-template",
  "smartphone",
  "presentation",
  "square-dashed",
  "arrow-up-right",
  "minus-square",
  "pin",
  // Feature modules (panels, inspector, AI dock, sync, export, sharing).
  "cloud",
  "cloud-check",
  "cloud-upload",
  "cloud-off",
  "cloud-alert",
  "cloud-download",
  "pipette",
  "log-in",
  "log-out",
  "user",
  "share-2",
  "link",
  "message-square",
  "message-square-plus",
  "send",
  "arrow-up",
  "circle-stop",
  "shapes",
  "palette",
  "images",
  "image-plus",
  "swatch-book",
  "layout-grid",
  "chart-column",
  "chart-pie",
  "table",
  "qr-code",
  "smile",
  "heading",
  "pilcrow",
  "list",
  "blend",
  "droplet",
  "contrast",
  "sliders-horizontal",
  "align-horizontal-space-around",
  "align-vertical-space-around",
  "rows-3",
  "columns-3",
  "play",
  "film",
  "sparkle",
  "square-round-corner",
  "rotate-ccw",
  "crop",
  "chevrons-up-down",
  "circle-dot",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "text-align-start",
  "text-align-center",
  "text-align-end",
  "text-align-justify",
  "case-sensitive",
  "arrow-up-to-line",
  "arrow-down-to-line",
  "fold-vertical",
  "corner-down-right",
  "link-2",
  "globe",
  "loader-circle",
  "sticker",
  "letter-text",
  "baseline",
  "move-horizontal",
  "move-vertical",
  "arrow-right",
  "arrow-down",
  "wrap-text",
  "reply",
  "circle-check-big",
  "zap",
  "aperture",
  "type-outline",
  "triangle",
  "hexagon",
  "squircle",
];

mkdirSync(out, { recursive: true });
for (const name of ICONS) {
  let file = `${name}.mjs`;
  let src = readFileSync(join(iconsDir, file), "utf8");
  // Renamed icons are re-exports of their new name.
  for (
    let alias = src.match(/export \{ default \} from '\.\/([^']+)'/);
    alias;
    alias = src.match(/export \{ default \} from '\.\/([^']+)'/)
  ) {
    file = alias[1];
    src = readFileSync(join(iconsDir, file), "utf8");
  }
  const m = src.match(/const __iconData = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error(`cannot parse ${name}`);
  const { node } = Function(`"use strict"; return (${m[1]});`)();
  const body = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ` +
    `stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
  writeFileSync(join(out, `${name}.svg`), svg);
}
writeFileSync(
  join(out, "LICENSE.txt"),
  `Icons from Lucide (${pkg.split("_")[0]}), ISC License.\n\n${readFileSync(join(store, pkg, "node_modules", "lucide-react", "LICENSE"), "utf8")}`,
);
console.log(`wrote ${ICONS.length} icons to ${out}`);
