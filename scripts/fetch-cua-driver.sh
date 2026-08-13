#!/bin/bash
# Bundle the installed cua-driver (as CuaDriver.app) into resources/cua-driver for packaging.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources/cua-driver
rm -rf resources/cua-driver/CuaDriver.app

APP=/Applications/CuaDriver.app
if [ ! -d "$APP" ]; then
  echo "CuaDriver.app not found in /Applications. Install it first:" >&2
  echo "  /bin/bash -c \"\$(curl -fsSL https://cua.ai/driver/install.sh)\"" >&2
  exit 1
fi

# Copy the binaries out of the bundle rather than the bundle itself. A nested
# .app signed by another team (Cua AI) sent notarization into manual review, and
# the bundle carried a second fragility: its signature covers Contents/Info.plist,
# so a stray cp -R that dropped that file made Apple reject the whole build.
# ditto preserves each binary's own signature; cp would break it.
for bin in cua-driver cua-cursor-theme; do
  src="$APP/Contents/MacOS/$bin"
  [ -f "$src" ] || { echo "missing $src in the installed driver" >&2; exit 1; }
  ditto "$src" "resources/cua-driver/$bin"
  codesign --verify --strict "resources/cua-driver/$bin" 2>/dev/null \
    || { echo "$bin failed signature verification after copy" >&2; exit 1; }
done

echo "bundled cua-driver binaries -> resources/cua-driver/"
resources/cua-driver/cua-driver --version
