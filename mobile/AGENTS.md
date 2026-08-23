# Expo HAS CHANGED

Read the exact versioned docs before writing any code:
https://docs.expo.dev/versions/v57.0.0/

**This project runs on SDK 57 with a development build, not Expo Go.**

## Why not Expo Go

The App Store build of Expo Go is stuck on SDK 54 and has not shipped an update
in about a year, while 55, 56 and 57 all released. Staying on 54 to keep Expo Go
working cost real things: expo-standard-web-crypto could not resolve against
SDK 54's expo-crypto, and expo-doctor found a missing peer that "may crash
outside of Expo Go" — Expo Go was hiding a bug rather than proving the app
worked.

So the client is ours now. `expo-dev-client` is installed and eas.json has a
`development` profile. Build it once:

    eas build --profile development --platform ios

Install that on the phone, then `npm start` and scan the QR exactly as before.
Fast Refresh and live reload work the same way. Rebuild only when native
dependencies change — never for a JavaScript change.

## Native modules

Third-party native modules are now allowed: the dev build compiles them in.
This is a change from the Expo Go era, when a single one made the project
unloadable.

Two things still argue for restraint. A native module means a rebuild and a
reinstall on every device before anyone can run the app, and an unmaintained
one is a liability the JavaScript alternative does not have. crypto.ts keeps
its pure-JavaScript @noble implementation of AES-GCM, SHA-256 and Ed25519 —
it works, it is audited, and replacing it buys nothing.

Prefer a pure-JavaScript dependency, or no dependency, when the difference is
small. Reach for a native module when it actually earns the rebuild.

## Permissions

Declare a permission only when a feature actually uses it. A usage string for
something a reviewer cannot find in the app is an App Store rejection. The mic
and notification permissions were removed for exactly this reason and come back
with the features that need them.
