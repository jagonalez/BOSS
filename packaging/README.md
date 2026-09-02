# Packaging the native app

Artifacts land in `dist/`. Every script works with no environment set — it
just skips signing and notarization and says so.

## macOS

```
./packaging/bundle-macos.sh
```

Produces `BOSS.app`, `BOSS-<version>-mac.zip`, `BOSS-<version>.dmg`, and
`latest-mac.json`. To sign and notarize:

```
export CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=78UU74XQFK
./packaging/bundle-macos.sh
```

## Windows

```
pwsh packaging/bundle-windows.ps1
```

Zip plus `latest-windows.json`, and an NSIS installer when `makensis` is on
PATH. Set `WINDOWS_CERT_FILE` and `WINDOWS_CERT_PASSWORD` to sign.

## Linux

```
./packaging/bundle-linux.sh
```

AppImage when `appimagetool` is on PATH, `.tar.gz` otherwise, plus
`latest-linux.json`.

## Shared options

| Variable | Effect |
|---|---|
| `BOSS_VERSION` | Version stamped into the bundle. Default: the workspace `Cargo.toml`. |
| `RELEASE_TAG` | Makes manifest URLs absolute against that release tag. |
| `SKIP_BUILD=1` | Reuse an existing `target/release/boss`. |
| `DIST_DIR` | Output directory. Default: `dist/`. |

The bundle id and product name come from `package.json`, so the native app and
the Electron app cannot disagree about their identity.

## Channels

A version with a prerelease suffix (`0.3.0-beta.7`) is a beta; anything else is
stable. `packaging/common.sh` writes that into the manifest, and the tag
(`vX.Y.Z-beta.N`) marks the GitHub release a prerelease. This is the same rule
the Electron `beta.yml` uses — betas are selected by tag, never by a separate
`beta-mac.yml`.
