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
codesign --verify resources/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver 2>/dev/null \
  || { echo "bundled binary failed signature verification"; exit 1; }
echo "bundled CuaDriver.app -> resources/cua-driver/CuaDriver.app"
resources/cua-driver/CuaDriver.app/Contents/MacOS/cua-driver --version
