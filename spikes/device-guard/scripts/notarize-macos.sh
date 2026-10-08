#!/bin/bash
# Notarizes and staples the spike app, then runs the host shim from a quarantined copy the
# way Chrome would (a direct exec, no LaunchServices), which is the open spike question.
# Needs an existing notarytool Keychain profile.
# Usage: scripts/notarize-macos.sh <keychain-profile> [app]
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="$1"
APP="${2:-out/Anon Network Guard Spike.app}"
TMP="$(mktemp -d)"
ditto -c -k --keepParent "$APP" "$TMP/spike.zip"
xcrun notarytool submit "$TMP/spike.zip" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
spctl -a -vv -t exec "$APP"

COPY="$TMP/Anon Network Guard Spike.app"
ditto "$APP" "$COPY"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$COPY"
python3 - "$COPY/Contents/MacOS/anon-guard-host" <<'PY'
import json, struct, subprocess, sys
msg = json.dumps({"op": "shimDescribe", "id": 1}).encode()
out = subprocess.run([sys.argv[1], "chrome-extension://spike/"], input=struct.pack("=I", len(msg)) + msg,
                     capture_output=True, timeout=30)
print("quarantined shim exit", out.returncode, out.stdout[4:].decode(errors="replace"), out.stderr.decode(errors="replace").strip())
PY
