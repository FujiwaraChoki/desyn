#!/usr/bin/env bash
# Builds Desyn.app on macOS (run on the Mac build host): release binary, Info.plist and an .icns rendered by the app.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../../.."
export CARGO_TARGET_DIR="$root/target/desyn-desktop"
cargo build --release -p desyn-desktop
app="$CARGO_TARGET_DIR/release/Desyn.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$CARGO_TARGET_DIR/release/desyn" "$app/Contents/MacOS/desyn"
cp "$here/Info.plist" "$app/Contents/Info.plist"
iconset="$(mktemp -d)/desyn.iconset"
mkdir -p "$iconset"
pngs="$(mktemp -d)"
"$app/Contents/MacOS/desyn" --write-icons "$pngs" >/dev/null
for s in 16 32 128 256 512; do
  cp "$pngs/desyn-$s.png" "$iconset/icon_${s}x${s}.png"
  d=$((s * 2)); cp "$pngs/desyn-$d.png" "$iconset/icon_${s}x${s}@2x.png" 2>/dev/null || true
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/desyn.icns"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "$app"
