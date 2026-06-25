# electron-builder buildResources

This directory is the `directories.buildResources` referenced by `electron-builder.json`.
electron-builder looks here for build-time assets that aren't part of the app bundle:

- `icon.icns` (macOS), `icon.ico` (Windows), `icon.png` (Linux / 512×512) — app icons.
- `entitlements.mac.plist` / `entitlements.mac.inherit.plist` — macOS hardened-runtime
  entitlements for notarization (microphone + screen-capture for meeting loopback).
- `background.png` / `dmg` layout assets (optional).

Signing, notarization, and the real icon/entitlement files are the on-device Mac step
(see `docs/MEETING-CAPTURE-VERIFY.md`). Keeping this directory in the repo lets
`electron-builder` resolve `buildResources` without error before those assets are added.
