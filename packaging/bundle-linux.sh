#!/usr/bin/env bash
# Build the Linux artifact: an AppImage when appimagetool is on PATH, a
# .tar.gz otherwise. Both carry the same tree, so the fallback is a real
# install and not a degraded one.
#
#   ./packaging/bundle-linux.sh
#
#   BOSS_VERSION   override the version
#   RELEASE_TAG    tag the manifest URLs point at
#   SKIP_BUILD=1   reuse an existing target/release/boss

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

cd "$REPO_ROOT"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> cargo build --release -p boss-app"
  ./scripts/cargo build --release -p boss-app
fi

BINARY="$REPO_ROOT/target/release/$BINARY_NAME"
[ -x "$BINARY" ] || { echo "no $BINARY; build first or unset SKIP_BUILD" >&2; exit 1; }

ARCH="$(uname -m)"
APPDIR="$DIST_DIR/$PRODUCT_NAME.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/boss"

cp "$BINARY" "$APPDIR/usr/bin/$BINARY_NAME"
chmod +x "$APPDIR/usr/bin/$BINARY_NAME"

# Same Contents/Resources layout as macOS, one level up: the app resolves
# bundled binaries relative to its own executable on every platform.
copy_resource_dir resources/opencode   "$APPDIR/usr/share/boss/opencode"
copy_resource_dir resources/cua-driver "$APPDIR/usr/share/boss/cua-driver"
copy_resource_dir resources/cli        "$APPDIR/usr/share/boss/cli"
copy_resource_dir resources/sites-mcp  "$APPDIR/usr/share/boss/sites-mcp"

cp resources/icons/512x512.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/boss.png"
cp resources/icons/512x512.png "$APPDIR/boss.png"

DESKTOP="$APPDIR/usr/share/applications/boss.desktop"
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=$PRODUCT_NAME
Comment=Configurable multi-backend desktop workspace for coding agents
Exec=$BINARY_NAME %U
Icon=boss
Categories=Development;
Terminal=false
StartupWMClass=$PRODUCT_NAME
DESK
cp "$DESKTOP" "$APPDIR/boss.desktop"

cat > "$APPDIR/AppRun" <<'RUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export PATH="$HERE/usr/bin:$PATH"
exec "$HERE/usr/bin/boss" "$@"
RUN
chmod +x "$APPDIR/AppRun"

if command -v appimagetool >/dev/null 2>&1; then
  OUT="$DIST_DIR/$PRODUCT_NAME-$VERSION-$ARCH.AppImage"
  echo "==> $(basename "$OUT")"
  rm -f "$OUT"
  ARCH="$ARCH" appimagetool "$APPDIR" "$OUT" >/dev/null
  chmod +x "$OUT"
else
  OUT="$DIST_DIR/$PRODUCT_NAME-$VERSION-$ARCH.tar.gz"
  echo "==> appimagetool not found; producing $(basename "$OUT")" >&2
  rm -f "$OUT"
  tar -C "$DIST_DIR" -czf "$OUT" "$(basename "$APPDIR")"
fi

write_manifest "$DIST_DIR/latest-linux.json" "$OUT" "$(asset_url "$(basename "$OUT")")"

echo "==> done: $DIST_DIR"
