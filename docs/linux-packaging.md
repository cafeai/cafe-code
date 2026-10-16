# Local Linux packages and AUR maintenance

Published [desktop releases](https://github.com/cafeai/cafe-code/releases/latest)
include a Linux **x64 AppImage**. The commands below are local build helpers;
they do not mean Debian packages, other architectures, or an updated AUR listing
are published with a release. See [source prerequisites](source-development.md)
before building.

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
