#!/usr/bin/env bash
# Build BOSS.app, sign it, notarize it, and produce a dmg, a zip, and the
# update manifest — the same set the Electron release publishes.
#
#   ./packaging/bundle-macos.sh
#
# Signing and notarization are opt-in through the environment. With none of
# these set the script still produces a working local bundle:
#   CODESIGN_IDENTITY   "Developer ID Application: ..."  — signs when set
#   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID — notarizes when all set
#   BOSS_VERSION        override the version stamped into the bundle
#   RELEASE_TAG         tag the manifest URLs point at
#   SKIP_BUILD=1        reuse an existing target/release/boss

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

MIN_OS="${MACOS_MIN_VERSION:-12.0}"
APP="$DIST_DIR/$PRODUCT_NAME.app"
CONTENTS="$APP/Contents"

cd "$REPO_ROOT"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> cargo build --release -p boss-app"
  MACOSX_DEPLOYMENT_TARGET="$MIN_OS" ./scripts/cargo build --release -p boss-app
fi

BINARY="$REPO_ROOT/target/release/$BINARY_NAME"
[ -x "$BINARY" ] || { echo "no $BINARY; build first or unset SKIP_BUILD" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BINARY" "$CONTENTS/MacOS/$BINARY_NAME"

echo "==> Info.plist ($BUNDLE_ID $VERSION, min macOS $MIN_OS)"
sed -e "s/@PRODUCT_NAME@/$PRODUCT_NAME/g" \
    -e "s/@BUNDLE_ID@/$BUNDLE_ID/g" \
    -e "s/@EXECUTABLE@/$BINARY_NAME/g" \
    -e "s/@VERSION@/$VERSION/g" \
    -e "s/@MIN_OS@/$MIN_OS/g" \
    "$PACKAGING_DIR/Info.plist.template" > "$CONTENTS/Info.plist"
printf 'APPL????' > "$CONTENTS/PkgInfo"

# iconutil wants an .iconset directory; the repo already ships the sizes as
# loose pngs, so assemble one rather than re-rendering from the svg. A prebuilt
# icon.icns is used as-is when iconutil is unavailable.
echo "==> icon"
ICONSET="$DIST_DIR/icon.iconset"
rm -rf "$ICONSET"
if command -v iconutil >/dev/null 2>&1 && [ -f resources/icons/icon-1024.png ]; then
  mkdir -p "$ICONSET"
  for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
              "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
              "512 512x512" "1024 512x512@2x"; do
    set -- $spec
    src="resources/icons/$1x$1.png"
    [ "$1" = 1024 ] && src=resources/icons/icon-1024.png
    [ -f "$src" ] || continue
    cp "$src" "$ICONSET/icon_$2.png"
  done
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/icon.icns"
  rm -rf "$ICONSET"
elif [ -f resources/icons/icon.icns ]; then
  cp resources/icons/icon.icns "$CONTENTS/Resources/icon.icns"
fi

# The app looks these up next to itself, the way the Electron build put them in
# Contents/Resources. Keeping the layout identical means the lookup code that
# handles a packaged build is the same shape in both.
copy_resource_dir resources/opencode   "$CONTENTS/Resources/opencode"
copy_resource_dir resources/cua-driver "$CONTENTS/Resources/cua-driver"
copy_resource_dir resources/cli        "$CONTENTS/Resources/cli"
copy_resource_dir resources/sites-mcp  "$CONTENTS/Resources/sites-mcp"
chmod +x "$CONTENTS/Resources/cli/$BINARY_NAME" 2>/dev/null || true

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  echo "==> codesign"
  # electron-builder's signIgnore for these two: the cua driver ships its own
  # signature from its own team, and re-signing it breaks the accessibility
  # permission the user already granted it. Sign everything else depth-first so
  # nested code is sealed before the bundle that contains it.
  SIGN_IGNORE=(cua-driver/cua-driver cua-driver/cua-cursor-theme)
  ignored() {
    local rel="${1#$CONTENTS/Resources/}"
    for skip in "${SIGN_IGNORE[@]}"; do [ "$rel" = "$skip" ] && return 0; done
    return 1
  }
  while IFS= read -r target; do
    ignored "$target" && { echo "    skip $(basename "$target")"; continue; }
    codesign --force --timestamp --options runtime \
      --entitlements "$PACKAGING_DIR/entitlements.mac.plist" \
      --sign "$CODESIGN_IDENTITY" "$target"
  done < <(find "$CONTENTS/Resources" \( -name '*.dylib' -o -name '*.so' -o -name '*.framework' -o -type f -perm -u+x \) -print 2>/dev/null | sort -r)

  codesign --force --timestamp --options runtime \
    --entitlements "$PACKAGING_DIR/entitlements.mac.plist" \
    --sign "$CODESIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  echo "==> CODESIGN_IDENTITY not set; leaving the bundle unsigned" >&2
fi

ZIP="$DIST_DIR/$PRODUCT_NAME-$VERSION-mac.zip"
DMG="$DIST_DIR/$PRODUCT_NAME-$VERSION.dmg"
rm -f "$ZIP" "$DMG"

# ditto rather than zip: it preserves the symlinks and extended attributes a
# signed bundle needs, and it is what the notary service expects.
echo "==> $(basename "$ZIP")"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "==> notarytool submit (Apple's queue decides how long this takes)"
  xcrun notarytool submit "$ZIP" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  # Stapling the app, then re-zipping: the ticket has to be inside the copy the
  # updater downloads, or a machine that is offline on first launch is refused.
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
else
  echo "==> notarization credentials absent; skipping notarization" >&2
fi

echo "==> $(basename "$DMG")"
STAGE="$DIST_DIR/dmg-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$PRODUCT_NAME $VERSION" -srcfolder "$STAGE" \
  -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$DMG"
  fi
fi

# The zip, not the dmg: an update installs itself, and a dmg needs someone to
# mount it and drag an icon.
write_manifest "$DIST_DIR/latest-mac.json" "$ZIP" "$(asset_url "$(basename "$ZIP")")"

echo "==> done: $DIST_DIR"
