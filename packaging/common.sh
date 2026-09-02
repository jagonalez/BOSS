#!/usr/bin/env bash
# Shared values for the bundle scripts. Sourced, not run.
#
# The identity of the app lives in package.json (bundle id, product name) and
# the version lives in the workspace Cargo.toml, because that is what the
# binary reports. Neither is duplicated here.

set -euo pipefail

PACKAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PACKAGING_DIR/.." && pwd)"

# A tiny reader rather than jq or node: CI runners have neither guaranteed, and
# these two keys are flat strings at the top level of package.json.
json_string() {
  local file="$1" key="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -1
}

BUNDLE_ID="$(sed -n '/"build"/,$p' "$REPO_ROOT/package.json" | sed -n 's/.*"appId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
PRODUCT_NAME="$(json_string "$REPO_ROOT/package.json" productName)"

# `[workspace.package] version` — the first `version = "x"` after that header.
# BOSS_VERSION overrides so CI can stamp a `-beta.N` build without a commit.
if [ -n "${BOSS_VERSION:-}" ]; then
  VERSION="$BOSS_VERSION"
else
  VERSION="$(sed -n '/^\[workspace.package\]/,/^\[/p' "$REPO_ROOT/Cargo.toml" \
    | sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi

: "${BUNDLE_ID:?appId missing from package.json build section}"
: "${PRODUCT_NAME:?productName missing from package.json}"
: "${VERSION:?version missing from the workspace Cargo.toml}"

# A build is a beta when its version carries a prerelease suffix. Same rule the
# Electron beta workflow uses, so one channel definition covers both apps.
if [[ "$VERSION" == *-* ]]; then CHANNEL=beta; else CHANNEL=stable; fi

DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
BINARY_NAME=boss

# sha512, base64, one line — the shape electron-updater's manifests use, so an
# installed Electron copy and a native copy agree on how to verify a download.
sha512_b64() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 512 -b "$1" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'
  else
    sha512sum "$1" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n'
  fi
}

# The manifest an installed copy reads to decide whether a newer build exists.
# Named latest-<os>.json rather than .yml: this updater is ours, and JSON needs
# no parser beyond the one already linked in.
write_manifest() {
  local path="$1" file="$2" url="$3"
  local sha size date
  sha="$(sha512_b64 "$file")"
  size="$(wc -c <"$file" | tr -d ' ')"
  date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat >"$path" <<JSON
{
  "version": "$VERSION",
  "name": "$(basename "$file")",
  "url": "$url",
  "sha512": "$sha",
  "size": $size,
  "releaseDate": "$date",
  "channel": "$CHANNEL"
}
JSON
  echo "==> $(basename "$path")"
}

# Where a release asset ends up once the workflow uploads it. Local builds have
# no release to point at, so the manifest carries the bare filename and the
# updater resolves it against the release it came from.
asset_url() {
  local name="$1"
  if [ -n "${RELEASE_TAG:-}" ]; then
    echo "https://github.com/jagonalez/BOSS/releases/download/$RELEASE_TAG/$name"
  else
    echo "$name"
  fi
}

# Bundled binaries are gitignored and fetched by CI. A local build without them
# should still produce a runnable app, so a missing directory is a warning.
copy_resource_dir() {
  local from="$1" to="$2"
  if [ -d "$from" ] && [ -n "$(ls -A "$from" 2>/dev/null | grep -v '^\.gitkeep$' || true)" ]; then
    mkdir -p "$to"
    cp -R "$from/." "$to/"
    echo "==> bundled $(basename "$from")"
  else
    echo "==> $(basename "$from") is empty; skipping (run the fetch scripts to include it)" >&2
  fi
}
