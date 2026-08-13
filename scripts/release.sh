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

# npm version creates the commit and the vX.Y.Z tag.
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version)"
VERSION="${NEW_VERSION#v}"
echo "==> Releasing $NEW_VERSION"

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

git add package.json package-lock.json
git commit -m "Release $NEW_VERSION"
git tag "$NEW_VERSION"
git push origin HEAD --tags

echo "==> Publishing $DMG"
gh release create "$NEW_VERSION" "$DMG" \
  --repo jagonalez/boss \
  --title "$NEW_VERSION" \
  --generate-notes

echo "==> Done. Installed copies will show the update banner on next launch."
