#!/usr/bin/env bash
# Cafe Code Linux user installer v1
# This single function is also the installed launcher, including when bootstrapped
# through stdin. Nothing downloaded from a release is executed during installation.
cafe_code() (
  set -euo pipefail
  umask 077

  fail() { printf 'Cafe Code: %s\n' "$*" >&2; exit 1; }
  case "${1:-}" in
    --help|-h)
      printf 'Usage: cafe-code [desktop arguments]\n       cafe-code up\n\nup installs the latest stable Linux x64 AppImage for this user.\n'
      exit 0
      ;;
    up) [[ $# == 1 ]] || fail 'Usage: cafe-code up' ;;
  esac

  [[ $(uname -s) == Linux ]] || fail 'This installer supports Linux only.'
  [[ $(uname -m) == x86_64 ]] || fail 'Published Linux releases support x86_64 only; use a source build on other architectures.'
  [[ $EUID != 0 ]] || fail 'Run as your normal desktop user, without sudo.'
  [[ ${HOME:-} == /* ]] || fail 'HOME must be an absolute path.'
  local data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  [[ $data_home == /* ]] || fail 'XDG_DATA_HOME must be an absolute path.'
  local install_dir=$data_home/cafe-code-desktop
  local bin_dir=$HOME/.local/bin
  local applications_dir=$data_home/applications
  local app_image=$install_dir/Cafe-Code.AppImage
  local launcher=$bin_dir/cafe-code
  local desktop_entry=$applications_dir/cafe-code-appimage.desktop

  # Desktop Exec has both string escaping and field-code expansion. Support spaces
  # with a quoted absolute executable, and refuse other metacharacters explicitly.
  case "$install_dir$bin_dir" in
    *[\"\`\$\\%]*|*$'\n'*|*$'\r'*|*$'\t'*) fail 'Install paths contain unsupported desktop-entry characters.' ;;
  esac

  safe_path() {
    local current=$1
    while [[ $current != / ]]; do
      [[ ! -L $current ]] || fail 'Install paths must not contain symbolic links.'
      current=${current%/*}
      [[ -n $current ]] || current=/
    done
  }
  safe_file() {
    safe_path "$1"
    if [[ -e $1 ]]; then
      [[ -f $1 && -O $1 ]] || fail 'An install target is not a regular user-owned file.'
    fi
  }
  safe_directory() {
    safe_path "$1"
    mkdir -p -- "$1"
    [[ -d $1 && -O $1 && -w $1 ]] || fail 'Install directories must be writable and owned by this user.'
  }

  if [[ ${1:-} != up ]]; then
    safe_file "$app_image"
    [[ -x $app_image ]] || fail 'Cafe Code is not installed. Run cafe-code up first.'
    # Retain the native AppImage runtime, APPIMAGE discovery and Chromium sandbox.
    # Inherited source-development switches must not turn a release into Debug.
    unset ELECTRON_RUN_AS_NODE CAFE_CODE_DESKTOP_DEV VITE_DEV_SERVER_URL CAFE_CODE_DEV_URL
    exec "$app_image" "$@"
  fi

  local tool
  for tool in curl sha256sum mktemp chmod mv cmp head cat mkdir rmdir rm; do
    command -v "$tool" >/dev/null || fail "Required command is missing: $tool"
  done
  safe_directory "$install_dir"
  safe_directory "$bin_dir"
  safe_directory "$applications_dir"
  safe_file "$app_image"
  safe_file "$launcher"
  safe_file "$desktop_entry"
  # Do not replace a registry/source launcher or a desktop entry owned by another
  # installation. Atomic replacement below never writes through existing links.
  if [[ -e $launcher ]]; then
    [[ $(head -n 2 -- "$launcher") == $'#!/usr/bin/env bash\n# Cafe Code Linux user installer v1' ]] || fail 'An unrelated ~/.local/bin/cafe-code already exists; move it before installing.'
  fi
  if [[ -e $desktop_entry ]]; then
    [[ $(head -n 2 -- "$desktop_entry") == $'[Desktop Entry]\nX-Cafe-Code-Installer=appimage-v1' ]] || fail 'An unrelated Cafe Code desktop entry already exists.'
  fi

  # An interrupted installer leaves a visible lock rather than guessing whether
  # another owner is dead from a PID. Only this invocation removes its own lock.
  local lock_dir=$install_dir/up.lock
  mkdir -- "$lock_dir" 2>/dev/null || fail 'Another install is reserved. If an earlier installer was interrupted, close it before removing cafe-code-desktop/up.lock.'
  local stage=''
  trap '[[ -z $stage ]] || rm -rf -- "$stage"; rmdir -- "$lock_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  stage=$(mktemp -d "$install_dir/.up.XXXXXXXX")

  local releases=https://github.com/cafeai/cafe-code/releases
  local latest tag version asset base checksum='' line matches=0
  local -a curl_options=(-q --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-redirs 5)
  printf 'Checking the latest stable Cafe Code release...\n'
  latest=$(curl "${curl_options[@]}" --max-time 60 --output /dev/null --write-out '%{url_effective}' "$releases/latest")
  [[ $latest == "$releases/tag/"* ]] || fail 'GitHub did not resolve an official release tag.'
  tag=${latest#"$releases/tag/"}
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'GitHub did not resolve a stable release version.'
  version=${tag#v}
  asset=Cafe-Code-$version-x86_64.AppImage
  base=$releases/download/$tag
  curl "${curl_options[@]}" --max-time 60 --max-filesize 1048576 --output "$stage/SHA256SUMS.txt" "$base/SHA256SUMS.txt"
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^([[:xdigit:]]{64})"  $asset"$ ]]; then
      checksum=${BASH_REMATCH[1]}
      matches=$((matches + 1))
    fi
  done < "$stage/SHA256SUMS.txt"
  [[ $matches == 1 ]] || fail 'Release checksums must identify exactly one matching x64 AppImage.'

  printf 'Downloading Cafe Code %s...\n' "$version"
  curl "${curl_options[@]}" --max-time 600 --max-filesize 1073741824 --output "$stage/Cafe-Code.AppImage" "$base/$asset"
  (cd -- "$stage" && printf '%s  Cafe-Code.AppImage\n' "$checksum" | sha256sum -c - >/dev/null) || fail 'AppImage checksum verification failed; the installed app was preserved.'

  printf '#!/usr/bin/env bash\n# Cafe Code Linux user installer v1\n' > "$stage/cafe-code"
  declare -f cafe_code >> "$stage/cafe-code"
  printf '\ncafe_code "$@"\n' >> "$stage/cafe-code"
  cat > "$stage/cafe-code-appimage.desktop" <<DESKTOP
[Desktop Entry]
X-Cafe-Code-Installer=appimage-v1
Type=Application
Name=Cafe Code
Comment=Desktop GUI for coding agents
Exec="$launcher" %U
Icon=applications-development
Terminal=false
Categories=Development;
StartupWMClass=cafe-code
DESKTOP
  chmod 755 "$stage/Cafe-Code.AppImage" "$stage/cafe-code"
  chmod 644 "$stage/cafe-code-appimage.desktop"

  # Stage each auxiliary file on its own filesystem before renaming it. The
  # AppImage stays on one fixed, versionless path which electron-updater preserves.
  # No app, backend or provider is launched, signalled or restarted here.
  local launcher_stage='' desktop_stage=''
  trap 'rm -f -- "${launcher_stage:-}" "${desktop_stage:-}"; [[ -z $stage ]] || rm -rf -- "$stage"; rmdir -- "$lock_dir"' EXIT
  launcher_stage=$(mktemp "$bin_dir/.cafe-code.XXXXXXXX")
  desktop_stage=$(mktemp "$applications_dir/.cafe-code.XXXXXXXX")
  cat "$stage/cafe-code" > "$launcher_stage"
  cat "$stage/cafe-code-appimage.desktop" > "$desktop_stage"
  chmod 755 "$launcher_stage"
  chmod 644 "$desktop_stage"
  safe_file "$app_image"
  safe_file "$launcher"
  safe_file "$desktop_entry"
  # Avoid replacing an identical executable, but do verify it against this
  # release every time. No version receipt can become stale after in-app updates.
  if [[ ! -f $app_image ]] || ! cmp -s -- "$stage/Cafe-Code.AppImage" "$app_image"; then
    mv -f -- "$stage/Cafe-Code.AppImage" "$app_image"
  fi
  mv -f -- "$launcher_stage" "$launcher"
  mv -f -- "$desktop_stage" "$desktop_entry"
  printf 'Installed Cafe Code %s. Launch with %s or the applications menu.\n' "$version" "$launcher"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *) printf 'For this terminal: export PATH="$HOME/.local/bin:$PATH"\n' ;;
  esac
  printf 'To update again: cafe-code up\n'
)

# With no arguments this file bootstraps installation. The generated launcher
# calls the same function with the original arguments, so no arguments launch it.
cafe_code "${@:-up}"
