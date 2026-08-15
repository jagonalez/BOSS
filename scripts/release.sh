#!/bin/bash
# Cut a release: bump the version, build the dmg, and publish it to GitHub.
# Usage: npm run release [patch|minor|major]   (default: patch)
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required. Install it with: brew install gh" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash your changes first." >&2
  git status --short >&2
  exit 1
fi

# Notarization runs inside `npm run dist`. Check the credentials up front rather
# than after a multi-minute build, and fail rather than silently shipping an
# unsigned build that auto-update cannot install.
# package.json carries notarize.teamId as a fallback; the env var wins and
# avoids electron-builder's deprecation warning.
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-78UU74XQFK}"

# Apple holds first submissions of an app identity for in-depth analysis, which
# has run past a day. SKIP_NOTARIZE=1 cuts a signed but unnotarized release
# rather than blocking the terminal on Apple's queue.
if [ "${SKIP_NOTARIZE:-}" = "1" ]; then
  echo "==> SKIP_NOTARIZE=1: signing without notarization"
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
elif [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD must be set to notarize." >&2
  echo "Create an app-specific password at appleid.apple.com," >&2
  echo "or re-run with SKIP_NOTARIZE=1 to cut a signed-only build." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "No Developer ID Application certificate in the keychain." >&2
  exit 1
fi

# npm version creates the commit and the vX.Y.Z tag.
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version)"
VERSION="${NEW_VERSION#v}"
echo "==> Releasing $NEW_VERSION"

# Notarization can block for a day, so interrupting a release is expected.
# Put the version back rather than leaving a bumped package.json that the
# dirty-tree check above would reject on the next attempt.
restore_version() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -z "${RELEASE_PUBLISHED:-}" ]; then
    git checkout -- package.json package-lock.json 2>/dev/null || true
    echo "==> Release aborted; version restored." >&2
  fi
}
trap restore_version EXIT INT TERM

echo "==> Typechecking"
npm run typecheck

echo "==> Building"
npm run dist

# electron-builder derives the artifact name from productName, version, and arch,
# so match on the extension rather than reconstructing the name here.
DMG="$(find dist -maxdepth 1 -name "*${VERSION}*.dmg" -print -quit)"
if [ ! -f "$DMG" ]; then
  echo "No .dmg for version ${VERSION} found in dist/ after the build." >&2
  ls -1 dist >&2
  exit 1
fi

# The manifest electron-updater reads to decide whether a newer version exists.
# Without it in the release, an installed copy finds the dmg and cannot tell
# what version it is — so the update banner never appears.
LATEST_YML="dist/latest-mac.yml"
if [ ! -f "$LATEST_YML" ]; then
  echo "No latest-mac.yml in dist/. Auto-update needs it; check build.publish in package.json." >&2
  exit 1
fi

# The zip is what auto-update downloads. A dmg needs a user to mount and drag.
ZIP="$(find dist -maxdepth 1 -name "*${VERSION}*-mac.zip" -print -quit)"
if [ ! -f "$ZIP" ]; then
  echo "No .zip for version ${VERSION} in dist/. Auto-update installs from it." >&2
  exit 1
fi

# Past this point the version is committed, so the abort trap must not revert it.
git add package.json package-lock.json
git commit -m "Release $NEW_VERSION"
RELEASE_PUBLISHED=1
git tag "$NEW_VERSION"
git push origin HEAD --tags

echo "==> Publishing $DMG"
gh release create "$NEW_VERSION" "$DMG" "$ZIP" "$LATEST_YML" \
  --repo jagonalez/BOSS \
  --title "$NEW_VERSION" \
  --generate-notes

echo "==> Done. Installed copies will show the update banner on next launch."
