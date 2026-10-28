#!/usr/bin/env bash
# Installs Desyn for the current user on Linux: binary, desktop entry, .desyn file type, desyn:// links and icons.
# Usage: apps/desktop/packaging/linux/install.sh [path/to/desyn]   (default: target/desyn-desktop/release/desyn)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${1:-$here/../../../../target/desyn-desktop/release/desyn}"
[ -x "$bin" ] || { echo "desyn binary not found at $bin (build with: cargo build --release -p desyn-desktop)" >&2; exit 1; }
data="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$HOME/.local/bin" "$data/applications" "$data/mime/packages"
install -m 0755 "$bin" "$HOME/.local/bin/desyn"
install -m 0644 "$here/app.desyn.Desyn.desktop" "$data/applications/"
install -m 0644 "$here/app.desyn.Desyn.xml" "$data/mime/packages/"
tmp="$(mktemp -d)"
"$HOME/.local/bin/desyn" --write-icons "$tmp" >/dev/null
for f in "$tmp"/desyn-*.png; do
  size="$(basename "$f" .png | cut -d- -f2)"
  dir="$data/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  install -m 0644 "$f" "$dir/app.desyn.Desyn.png"
done
rm -rf "$tmp"
command -v update-mime-database >/dev/null && update-mime-database "$data/mime"
command -v update-desktop-database >/dev/null && update-desktop-database "$data/applications"
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$data/icons/hicolor" || true
if command -v xdg-mime >/dev/null; then
  xdg-mime default app.desyn.Desyn.desktop application/x-desyn
  xdg-mime default app.desyn.Desyn.desktop x-scheme-handler/desyn
fi
echo "Desyn installed. Open .desyn files or desyn:// links, or run: desyn"
