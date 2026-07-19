#!/usr/bin/env bash

set -euo pipefail

eval "$(printf '%s\n' cafecode-clean-room-keyring | gnome-keyring-daemon --unlock --components=secrets)"
xvfb-run --auto-servernum corepack yarn test:native-linux-artifact
