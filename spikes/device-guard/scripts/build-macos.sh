#!/bin/bash
# Builds, bundles and signs the spike app. SIGN_IDENTITY="-" signs ad hoc.
# Usage: scripts/build-macos.sh [out-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-out}"
IDENTITY="${SIGN_IDENTITY:-Developer ID Application: AHLOOP LLC (G4CUY3UK8U)}"
APP="$OUT/Anon Network Guard Spike.app"

cargo build --release --quiet
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Library/LaunchAgents"
cp macos/Info.plist "$APP/Contents/Info.plist"
cp target/release/anon-guard target/release/anon-guard-host "$APP/Contents/MacOS/"
cp macos/inc.anon.network-guard.spike.agent.plist "$APP/Contents/Library/LaunchAgents/"

sign() { codesign --force --options runtime --timestamp --sign "$IDENTITY" "$@"; }
if [ "$IDENTITY" = "-" ]; then sign() { codesign --force --options runtime --sign - "$@"; }; fi
# Inside out: the nested host first, then the bundle (never --deep).
sign --identifier inc.anon.network-guard.spike.host "$APP/Contents/MacOS/anon-guard-host"
sign "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"
echo "$APP"
