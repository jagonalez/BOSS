#!/bin/bash
# Bundle the cua-driver binaries into resources/cua-driver for packaging.
#
# Pulls the pinned release tarball from GitHub. The tarball carries the bare
# binaries at its top level, so no install step and no /Applications copy is
# needed — which is what lets this run on a CI runner. A machine with the
# driver already installed is used only as an offline fallback.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pin rather than track latest: a nightly build that silently changes its
# bundled driver is not reproducible, and a driver regression would look like
# a BOSS regression. Raise this deliberately.
# 0.20.0 is the first release that verifies exact-window foreground focus
# before dispatch, avoiding the activation race in the final delivery rung.
VERSION="${CUA_DRIVER_VERSION:-0.20.0}"
REPO="trycua/cua"
STAGE="cua-driver-rs-${VERSION}-darwin-universal"
TARBALL="${STAGE}.tar.gz"
URL="https://github.com/${REPO}/releases/download/cua-driver-rs-v${VERSION}/${TARBALL}"

DEST="resources/cua-driver"
mkdir -p "$DEST"
# Older layouts shipped the whole bundle. Leaving one behind would let the app
# resolve a stale driver ahead of the flat binaries.
rm -rf "$DEST/CuaDriver.app"

# Copy the individual binaries, never the nested .app. A nested .app signed by
# another team (Cua AI) sent notarization into manual review, and the bundle
# carried a second fragility: its signature covers Contents/Info.plist, so a
# stray cp -R that dropped that file made Apple reject the whole build.
# ditto preserves each binary's own signature; cp would break it.
install_from() {
  local src="$1"
  for bin in cua-driver cua-cursor-theme; do
    [ -f "$src/$bin" ] || { echo "missing $bin in $src" >&2; return 1; }
    # ditto merges onto an existing path, so clear the old binary first rather
    # than shipping a stale one that survived an earlier run.
    rm -f "$DEST/$bin"
    ditto "$src/$bin" "$DEST/$bin"
    codesign --verify --strict "$DEST/$bin" 2>/dev/null \
      || { echo "$bin failed signature verification after copy" >&2; return 1; }
  done
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if curl -fsSL "$URL" -o "$TMP/$TARBALL"; then
  tar -xzf "$TMP/$TARBALL" -C "$TMP"
  install_from "$TMP/$STAGE"
elif [ -d /Applications/CuaDriver.app ]; then
  # No network, or the pinned release is gone. An installed driver is whatever
  # version the machine happens to have, so say which one got bundled.
  echo "==> Could not fetch $VERSION; falling back to the installed driver." >&2
  install_from /Applications/CuaDriver.app/Contents/MacOS
else
  echo "Could not download $URL and no driver is installed." >&2
  echo "Install one with:" >&2
  echo "  /bin/bash -c \"\$(curl -fsSL https://cua.ai/driver/install.sh)\"" >&2
  exit 1
fi

echo "bundled cua-driver binaries -> $DEST/"
"$DEST/cua-driver" --version
