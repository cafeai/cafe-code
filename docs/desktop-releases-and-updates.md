# Desktop Releases And Updates

Cafe Code publishes intentionally unsigned desktop artifacts from version tags. Stable tags use
`vX.Y.Z`; nightly tags use `vX.Y.Z-nightly.YYYYMMDD.N` with `N >= 1`. The release workflow builds
Windows x64 NSIS, macOS arm64/x64 DMG plus updater ZIP, and Linux x64 AppImage. Linux formats other
than x64 AppImage are not currently supported.

Before publication, the workflow merges the two macOS manifests and verifies every updater asset's
size and SHA-512 digest. It also publishes `SHA256SUMS.txt` for manual downloads. After publication,
a lower-version packaged AppImage runs a detection-only probe against the public GitHub feed and
must report the exact released version. The probe never downloads or installs the update.

## Runtime Behavior

Packaged apps check 15 seconds after launch and every four minutes afterward. Users can also check
from the application menu. Cafe Code does not automatically download an update and does not install
one merely because the app exits.

- Windows x64: the user downloads from Cafe Code and confirms restart. The unsigned NSIS installer
  runs for the current user with Electron Updater's `--updated /S --force-run` arguments. The update
  path does not rerun the fresh-install managed-provider bootstrap. Windows may show Unknown
  Publisher or SmartScreen warnings because there is no Authenticode certificate.
- macOS arm64/x64: Cafe Code detects the release but opens its exact GitHub release page for manual
  DMG installation. Replace Cafe Code in `/Applications` from the DMG. Squirrel.Mac requires a
  signed app, so unsigned builds must never offer in-place restart-and-install. Gatekeeper may
  require the user to approve the unsigned app in Privacy & Security.
- Linux x64 AppImage: update checks run only when Cafe Code was launched from an AppImage and the
  `APPIMAGE` path is available. After an explicit download and restart confirmation, Electron
  Updater replaces the AppImage and relaunches it. The containing directory and AppImage must be
  writable. If replacement fails, download the newer AppImage from GitHub and run it manually.

Source checkouts use the separate Git branch update diagnostic. They compare commits on `main` or
`dev`; they do not consume GitHub Release manifests and cannot install packaged updates.

## Trust Model

The feed and artifacts are delivered over GitHub HTTPS, and Electron Updater verifies the SHA-512
digest recorded in the release manifest before using a downloaded Windows or Linux artifact. This
detects transport corruption but does not establish publisher identity. Anyone who can publish to
the GitHub repository can distribute an unsigned executable accepted by the updater. Adding Apple
Developer ID signing/notarization and Windows Authenticode signing is required before describing
these artifacts as publisher-authenticated.
