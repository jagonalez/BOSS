# Expo HAS CHANGED

Read the exact versioned docs before writing any code:
https://docs.expo.dev/versions/v54.0.0/

**This project is pinned to SDK 54, not the latest.** The App Store build of
Expo Go supports SDK 54; a project on 57 reports "incompatible" and will not
load on a phone at all. Do not upgrade the SDK to fix an unrelated problem —
it costs the ability to test without a custom build.

## Native modules

Every dependency here must be an Expo-published module. A single third-party
native module (react-native-quick-crypto, react-native-get-random-values) makes
the project unloadable in Expo Go. That is why crypto.ts implements AES-GCM,
SHA-256 and Ed25519 with @noble in pure JavaScript.

## Permissions

Declare a permission only when a feature actually uses it. A usage string for
something a reviewer cannot find in the app is an App Store rejection. The mic
and notification permissions were removed for exactly this reason and come back
with the features that need them.
