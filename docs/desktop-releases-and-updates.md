# Desktop Releases And Updates

Cafe Code publishes desktop artifacts from version tags. macOS apps are Developer ID signed and
notarized; Windows and Linux artifacts remain unsigned. Stable tags use
`vX.Y.Z`; nightly tags use `vX.Y.Z-nightly.YYYYMMDD.N` with `N >= 1`. The release workflow builds
Windows x64 NSIS, macOS arm64/x64 DMG plus updater ZIP, and Linux x64 AppImage. Linux formats other
than x64 AppImage are not currently supported.

Before publication, the exact tag commit runs the reusable native quality and reliability
workflows, including full/focused browser coverage, the immutable release smoke, and an
unfiltered dependency audit. Every artifact passes its native readiness/install checks before
its source SHA and asset bytes are sealed. Publication rechecks that complete four-target
evidence set, merges macOS manifests and verifies updater sizes and SHA-512 digests. It publishes
`SHA256SUMS.txt` for manual downloads. A lower-version packaged AppImage must identify the exact
candidate through a local feed before GitHub publication; the public GitHub feed is checked
again afterward. These probes detect updates without downloading or installing them.

A release branch can run the same gated workflow before its tag exists:
`gh workflow run release.yml --ref release/0.2.0 -f version=v0.2.0 -f publish_release=true`.
The manual run pins the branch's event commit. It creates the tag only after all quality,
reliability, signed-artifact, checksum and candidate-feed checks succeed, then publishes the
qualified bytes. It never force-updates an existing tag. Omitting `publish_release=true` builds
and qualifies artifacts without creating a tag or GitHub release.

An explicitly requested build-only release adds `-f build_only=true` to that manual command.
It skips quality/reliability workflows, native runtime/install tests and update-detection probes.
It still builds all four targets, requires macOS signing and notarization, verifies the ZIP app's
signature and stapled ticket, and validates exact-source artifact hashes and update manifests
before creating the tag or publishing. Normal CI and the default gated release path are unchanged.
Build-only publication does not establish that the skipped runtime/install checks passed.

If the public-feed probe fails, stop promotion and announce the affected tag through the normal
release process. Inspect the exact version/feed/artifact evidence, then withdraw the broken
release from the public update feed or publish a corrected higher version after all gates pass.
Do not move an existing tag, replace qualified binaries silently, or bypass the failed check.
Withdrawal/replacement is a separately authorized release action.

## Windows managed providers

A fresh Windows installation can use the offline, reviewed Node/Codex/Claude bundle. Package
versions, native architecture closure and archive integrity are recorded in
`packaging/managed-providers/manifest.json`. Installation needs no registry access and executes
no package scripts. The hidden installer holds an OS file guard, stages an exclusive generation,
verifies every file and exact runtime version, and publishes a single activation record.
First-run bundled preferences publish only after successful preparation and activation; existing
preferences remain intact. Failures return nonzero to NSIS and preserve the prior generation
and recovery records. An interrupted preparation child cannot activate its files.

Repair by rerunning the reviewed installer. Selected generations are immutable to Cafe's package
update controls. Old `current` paths remain compatible when no activation record exists; an
invalid activation record fails closed. Application updates retain the existing `--updated`
exclusion from fresh provider bootstrap. Neither repair nor uninstall guesses which unselected
or running generation can be deleted; retained user runtime/data policy is unchanged.

## Runtime Behavior

Packaged apps check 15 seconds after launch and every four minutes afterward. Users can also check
from the application menu. Cafe Code does not automatically download an update and does not install
one merely because the app exits.

- Windows x64: the user downloads from Cafe Code and confirms restart. The unsigned NSIS installer
  runs for the current user with Electron Updater's `--updated /S --force-run` arguments. The update
  path does not rerun the fresh-install managed-provider bootstrap. Windows may show Unknown
  Publisher or SmartScreen warnings because there is no Authenticode certificate.
- macOS arm64/x64: signed and notarized packages opt into in-app updates. The user downloads the
  update from Cafe Code and confirms restart; Electron Updater selects the matching architecture's
  ZIP and hands it to Squirrel.Mac for native signature validation, replacement and relaunch.
  An Intel build running under Rosetta switches to the native Apple Silicon ZIP. Unsigned local
  packages retain the exact GitHub release link for manual DMG installation. Both architecture
  builds must pass native signature, Gatekeeper and stapled-notarization checks before publication;
  build-only runs check the ZIP app.
- Linux x64 AppImage: update checks run only when Cafe Code was launched from an AppImage and the
  `APPIMAGE` path is available. After an explicit download and restart confirmation, Electron
  Updater replaces the AppImage and relaunches it. The containing directory and AppImage must be
  writable. If replacement fails, download the newer AppImage from GitHub and run it manually.

Source checkouts use the separate Git branch update diagnostic. They compare commits on `main` or
`dev`; they do not consume GitHub Release manifests and cannot install packaged updates.

macOS packages opt in through the bundled `package.json` field `cafeCodeMacInAppUpdates: true`,
which the signed packaging path writes alongside its required signing/notarization configuration.
This field selects installation policy; Squirrel.Mac remains responsible for authenticating the
replacement app. Missing, false, malformed or unreadable metadata retains manual installation.
The mode is captured from the installed package and preserved when switching update tracks.
Already released macOS versions through 0.2.0 retain their shipped manual policy and need one
manual DMG upgrade to a release containing this change before subsequent in-app updates work.
Native signed-app upgrade/relaunch qualification remains a separate release check; unit tests,
manifest validation and detection-only probes do not establish a successful Squirrel.Mac install.

## Trust Model

The feed and artifacts are delivered over GitHub HTTPS, and Electron Updater verifies the SHA-512
digest recorded in the release manifest before using a downloaded updater payload. This detects
transport corruption but does not establish publisher identity. macOS additionally retains
Squirrel.Mac's native app-signature checks. Windows artifacts still require Authenticode signing
before their publisher can be authenticated. macOS release builds
require the registered `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` Actions secrets. Only the macOS release build
step receives them. The builder requires a signing identity and notarization; unsigned fallback
is an error. Actual app signatures, Gatekeeper admission and stapled tickets are checked before
artifact identities are sealed. The default gated path checks both DMG and ZIP copies;
the explicitly selected build-only path checks the ZIP copy without launching the app.

Native CI smoke tests keep Chromium sandboxing and the real safe-storage round
trip enabled. Linux opts into configuring only its private extracted
`chrome-sandbox` helper in the runner workspace's temporary area as root-owned
mode `4755`, rejecting shared or symlinked
helpers and checking inode identity afterward. Its fresh D-Bus session owns a private native
GNOME secret service and random keyring password; its process and private files retire after
qualification. macOS configures a private, unlocked temporary keychain inside the exact fresh
`HOME` and `CFFIXED_USER_HOME` used by each DMG/ZIP runtime check. Both the search preferences
and keychain live under that fixture home; existing user preferences remain untouched. The
keychain is deleted on success or failure, followed by the owned temporary home. Synthetic random
safe-storage keys in that disposable keychain avoid unsigned CI permission dialogs while
retaining the real OS-backed encryption/decryption check.
These options are scoped to their respective artifact steps; ordinary launches
and local smoke commands retain their existing OS policy. No signing identity,
provider account or existing keychain contents participate in this setup.

The Windows smoke sends NSIS's final `/D=` tail verbatim, preserving spaces
without CRT-style quoting, as required by the [NSIS command-line contract](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage).
Bootstrap failures retain exit code `1`; the error dialog uses its silent-mode
default so unattended installs can fail without waiting for a click.
