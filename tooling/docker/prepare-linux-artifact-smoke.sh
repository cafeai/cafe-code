#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

artifacts=(release/Cafe-Code-*-x86_64.AppImage)
if (( ${#artifacts[@]} != 1 )); then
  printf 'Expected exactly one Linux x64 AppImage, found %s.\n' "${#artifacts[@]}" >&2
  exit 1
fi

smoke_root=/tmp/cafecode-appimage-smoke
if [[ -e "$smoke_root" ]]; then
  printf 'Refusing to reuse existing AppImage smoke root: %s\n' "$smoke_root" >&2
  exit 1
fi
install -d -m 0755 "$smoke_root"
(
  cd "$smoke_root"
  "/workspace/${artifacts[0]}" --appimage-extract >/dev/null
)

chmod -R a+rX "$smoke_root/squashfs-root"
chrome_sandbox="$smoke_root/squashfs-root/chrome-sandbox"
chown root:root "$chrome_sandbox"
chmod 4755 "$chrome_sandbox"
test "$(stat -c '%U:%G:%a' "$chrome_sandbox")" = 'root:root:4755'
