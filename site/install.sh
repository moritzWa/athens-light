#!/bin/sh
# Installs the latest Athens Light build into /Applications.
set -eu

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Athens Light currently runs on Apple silicon Macs only." >&2
  exit 1
fi

URL="https://github.com/moritzWa/athens-light/releases/download/latest/Athens-Light-arm64.zip"
APP="/Applications/Athens Light.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Athens Light..."
curl -fsSL "$URL" -o "$TMP/app.zip"
ditto -x -k "$TMP/app.zip" "$TMP"

if pgrep -xq "athens-light"; then
  osascript -e 'tell application "Athens Light" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -xq "athens-light" || break
    sleep 1
  done
  if pgrep -xq "athens-light"; then
    echo "Athens Light is still open. Save your work, quit it, and run this again." >&2
    exit 1
  fi
fi

rm -rf "$APP"
ditto "$TMP/Athens Light.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Installed $APP"
open "$APP"
