# Linux installation, updates and local packages

Published [desktop releases](https://github.com/cafeai/cafe-code/releases/latest)
include a Linux **x64 AppImage**. The user installer below downloads that release;
Debian and Arch helpers build locally. Other architectures and package formats
are not part of the published release set.

## Install or update with `cafe-code up`

On an x86_64 Linux desktop, bootstrap the user installer:

```bash
curl -fsSL https://cafecode.sh/install.sh | bash
```

This URL becomes available when the website's reviewed installer and download
section are deployed. The website serves a copy of this repository's script;
it downloads release assets directly from GitHub without requiring the source
branch to be public. From a checkout containing the script, the equivalent
command is:

```bash
bash scripts/install-linux.sh
```

After the first installation:

```bash
cafe-code        # launch the desktop app
cafe-code up     # download and install the latest stable release
```

Use your normal user account, without `sudo`. The installer requires Bash, curl
and standard coreutils including `sha256sum`; it needs no Node installation or
source compilation. If `~/.local/bin` is absent from your terminal's PATH, run
`export PATH="$HOME/.local/bin:$PATH"` or use `~/.local/bin/cafe-code` directly.
The applications-menu entry uses an absolute launcher path.

The installer resolves GitHub's latest stable tag once, downloads that tag's
`SHA256SUMS.txt` and matching x86_64 AppImage over HTTPS, and verifies the exact
SHA-256 before replacement. Missing or duplicate checksum entries, failed
downloads and checksum mismatches preserve the installed executable. Linux
releases remain unsigned: a checksum delivered alongside the binary detects
corruption, but is not an independent publisher signature.

The launcher lives at `~/.local/bin/cafe-code`; the AppImage lives at
`${XDG_DATA_HOME:-$HOME/.local/share}/cafe-code-desktop/Cafe-Code.AppImage`.
The applications entry is `cafe-code-appimage.desktop` in that data home's
`applications` directory. Keep the same `XDG_DATA_HOME` when installing and
launching. The versionless AppImage filename is deliberate: Electron Updater
preserves custom names, so in-app updates retain the launcher target. Files stay
writable by the installing user. The installer refuses symlinked install paths,
non-owned targets, unsupported desktop-entry path characters, an unrelated
`~/.local/bin/cafe-code`, and concurrent installer reservations.

Quit Cafe Code normally before using `cafe-code up`, then launch it when ready.
The command only installs files; it does not stop running work or launch/restart
the app. It does not install providers or alter account/profile data. A forcibly
interrupted installer can leave `cafe-code-desktop/up.lock`; remove that empty
directory only after establishing that the earlier installer has ended.

## In-app updates on Linux

The published x64 AppImage also supports in-app updates when launched through
its native AppImage runtime, with `APPIMAGE` available and both the file and its
directory writable. Cafe checks after startup and periodically, but download
and installation require explicit actions and native restart confirmation.
The user installer above retains this path and does not extract the AppImage or
disable Chromium sandboxing. Normal AppImage host prerequisites still apply;
see the [AppImage running guide](https://docs.appimage.org/user-guide/run-appimages.html)
for host setup and troubleshooting.

Local Debian/Arch installs use their package manager rather than this AppImage
updater. Source checkouts use Git diagnostics. See the complete
[desktop update behavior](desktop-releases-and-updates.md#runtime-behavior).
Native Linux upgrade/relaunch qualification remains separate from synthetic
installer transport tests or qualification on another host.

See [source prerequisites](source-development.md) before building the local
packages below.

## Local Arch package

On Arch Linux, build a pacman package around an AppImage from the current checkout:

```bash
corepack yarn install --immutable
corepack yarn dist:arch:local
sudo pacman -U release/arch/cafe-code-*.pkg.tar.zst
```

To build and install in one step:

```bash
corepack yarn dist:arch:local --install
```

This helper does not publish anything.

## AUR source recipe

The recipe in [packaging/aur/cafe-code](../packaging/aur/cafe-code) builds the
tagged **0.2.0** source release into a local AppImage and pacman package. It does
not package the current checkout. Its source archive and helper files have
explicit SHA-256 checksums.

On Arch Linux:

```bash
corepack yarn dist:aur:cafe-code
```

The build runs `makepkg` in `packaging/aur/cafe-code/`. That directory also holds
the `PKGBUILD`, generated `.SRCINFO`, launcher, desktop entry, and packaging
license used for a separate AUR Git repository. This checkout alone does not
establish that the AUR listing has been submitted or updated.

For a new release, update `pkgver`, reset `pkgrel` to `1`, select the exact
release archive and verify its checksum. Update helper checksums only when those
files change. Check the recipe's native prerequisites and runtime pins against
the selected source, build on Arch, then regenerate metadata with
`makepkg --printsrcinfo > .SRCINFO`.

Submitting or updating the separate AUR repository requires an AUR account and
SSH key. Copy the reviewed recipe files into that repository, inspect the diff,
build them there, and commit with a subject such as
`build(aur): package Cafe Code 0.2.0`. Publishing that repository is a separate
maintainer action.

## Local Debian package

Build on Linux for the host architecture:

```bash
corepack yarn install --immutable
corepack yarn dist:desktop:deb
```

Explicit targets are also available:

```bash
corepack yarn dist:desktop:deb:x64
corepack yarn dist:desktop:deb:arm64
```

Output goes to `release/`. Install the emitted package with a graphical package
installer or `sudo apt install ./release/<file>.deb`.
These local targets are separate from the published x64 AppImage release and its
in-app update path. Native builds and installation must be qualified on the
target host; a macOS check does not establish Arch or Debian behavior.
