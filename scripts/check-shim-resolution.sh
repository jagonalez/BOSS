#!/bin/sh
# Proves the shim resolves its own symlink back to the app bundle.
# Builds a fake BOSS.app, symlinks the shim into a fake PATH dir the way the
# installer does, and echoes what the shim computed instead of launching.
set -eu

work=$(mktemp -d "${TMPDIR:-/tmp}/boss-shim-check.XXXXXX")
trap 'rm -rf "$work"' EXIT

app="$work/BOSS.app"
mkdir -p "$app/Contents/Resources/cli" "$app/Contents/MacOS" "$work/bin"
cp "$(dirname "$0")/../resources/cli/boss" "$app/Contents/Resources/cli/boss"
chmod +x "$app/Contents/Resources/cli/boss"
ln -s "$app/Contents/Resources/cli/boss" "$work/bin/boss"

# Replace the launch with an echo so the check needs no real app.
sed -e 's|^    open -a "$app" --args --boss-open "$target"$|    echo "APP=$app TARGET=$target"|' \
    "$app/Contents/Resources/cli/boss" > "$app/Contents/Resources/cli/boss.probe"
chmod +x "$app/Contents/Resources/cli/boss.probe"
ln -s "$app/Contents/Resources/cli/boss.probe" "$work/bin/boss-probe"

mkdir -p "$work/project"
out=$(cd "$work/project" && "$work/bin/boss-probe" .)

expected_app=$(cd "$app" && pwd -P)
expected_target=$(cd "$work/project" && pwd -P)
if [ "$out" = "APP=$expected_app TARGET=$expected_target" ]; then
  echo "ok: shim resolved through symlink -> $out"
else
  echo "FAIL: got [$out]" >&2
  echo "      want [APP=$expected_app TARGET=$expected_target]" >&2
  exit 1
fi
