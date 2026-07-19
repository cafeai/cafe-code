#!/usr/bin/env bash

set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  printf 'The container artifact smoke wrapper must run as root.\n' >&2
  exit 1
fi

install -d -m 0755 /run/dbus
install -d -m 1777 /tmp/.X11-unix
dbus-daemon --system --fork
exec runuser -u node -- dbus-run-session -- bash tooling/docker/run-linux-artifact-smoke-as-user.sh
