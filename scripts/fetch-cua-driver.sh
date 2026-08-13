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

# Preserve code signature (cp breaks the cdhash / embedded Info.plist).
ditto "$APP" resources/cua-driver/CuaDriver.app

# Verify the whole bundle with --strict, not just the inner binary. Notarization
# once failed with "The signature of the binary is invalid" because Info.plist,
# CodeResources, and Resources/ had been stripped from the copy — the binary
# alone still passed a non-strict check, so this script reported success.
codesign --verify --strict resources/cua-driver/CuaDriver.app 2>/dev/null \
  || { echo "bundled CuaDriver.app failed signature verification" >&2; exit 1; }
for required in Info.plist CodeResources; do
  [ -f "resources/cua-driver/CuaDriver.app/Contents/$required" ] \
    || { echo "bundled CuaDriver.app is missing Contents/$required" >&2; exit 1; }
done
echo "bundled CuaDriver.app -> resources/cua-driver/CuaDriver.app"
resources/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver --version
