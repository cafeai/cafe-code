# Desktop Releases And Updates

Last updated: 2026-10-20 21:56:16 JST (UTC+0900)

Cafe Code publishes desktop artifacts from version tags. macOS apps are Developer ID signed and
notarized; Windows and Linux artifacts remain unsigned. Stable tags use
`vX.Y.Z`; nightly tags use `vX.Y.Z-nightly.YYYYMMDD.N` with `N >= 1`. The release workflow builds
Windows x64 NSIS, macOS arm64/x64 DMG plus updater ZIP, and Linux x64 AppImage.
Published Linux artifacts are limited to x64 AppImage; local Debian and Arch
build helpers are documented in [Linux packaging](linux-packaging.md).

Normal CI is the release quality gate. The exact source commit runs the same reusable
CI workflow as dev/main, including Node tests, browser checks and desktop builds.
The release builds all four shipping targets in parallel with CI, and publication
waits for both to pass. macOS requires Developer ID
signing, hardened runtime and notarization, with native signature, Gatekeeper and
stapled-ticket verification. Publication verifies the complete four-target source
and byte evidence, merges macOS manifests, validates updater sizes and SHA-512
digests, and publishes `SHA256SUMS.txt` for manual downloads.

The ephemeral GitHub-hosted Intel Mac release VM blocks outbound UDP port 443
before notarization so Apple's ticket requests fall back from HTTP/3 to HTTPS
over TCP. This follows the runner maintainers' workaround for
[runner-images issue 14924](https://github.com/actions/runner-images/issues/14924).
It does not change local machines or packaged apps, and signature, Gatekeeper
and stapled-ticket validation remain mandatory. Remove the workaround once the
upstream Intel runner network issue is resolved and qualified.

Every new desktop release requires a matching `release/<version>` branch alongside
its `v<version>` tag, both identifying the exact frozen, qualified source commit.
Use the complete version without the tag's leading `v` for the branch, including
nightly suffixes: for example, `release/0.2.4` and `v0.2.4`. After approval for the
specific release, create the remote branch only if it is absent; otherwise verify
its exact current commit. If an existing branch points elsewhere, stop rather
than moving, resetting or force-updating it. Branch admission is an operational
preflight check, not a new workflow bypass or automatic enforcement claim.

Normally dispatch from the matching release branch before its tag exists.
Substitute the deliberately selected, unused version and verified branch in this
template:
`gh workflow run release.yml --ref release/X.Y.Z -f version=vX.Y.Z -f publish_release=true -f build_only=false`.
Bind the actual event SHA and the workflow's prepared source SHA to the frozen
commit; a matching branch name alone is not source evidence. The manual run creates
the tag only after normal CI, signed builds, artifact identity checks and manifest
validation pass. It never force-updates an existing tag. Omitting
`publish_release=true` builds and validates artifacts without creating a tag or
GitHub release.

If an approved release run was already dispatched from another ref, retain its
original event commit and create or verify the matching release branch at that
same commit before publication. Do not retarget or redispatch an in-flight run
merely to change its ref.

Additional process-lifecycle, native installer/runtime and packaged update-feed
probes run separately as optional qualification. They are not required by the
normal release workflow, which does not launch the packaged app or create a
second lower-version probe build.

An explicitly requested build-only release adds `-f build_only=true` to the
manual command. It skips normal CI while retaining the same four-target builds,
macOS signing/notarization, native signature/ticket verification, exact-source
artifact hashes and update-manifest checks. It does not establish that normal CI
passed. Never move an existing release tag or silently replace published binaries;
withdrawal or replacement remains a separately authorized release action.

## Release notes and post-publication checks

Every release needs reviewed notes describing what changed since the previous
published release, not only the workflow's generic installer paragraph. Prepare
the notes from the frozen source comparison before publication, then verify and
publish the reviewed body after the normal workflow finishes and before calling
the release complete. This is a required maintainer step: the current workflow
does not automatically produce a reviewed changelog. An ordinary dev push does
not publish a release or authorize editing an earlier release's notes.

For a stable release, select the preceding published, non-draft stable release,
excluding the current release and prereleases. For a nightly, deliberately choose
and record the preceding published nightly on that channel; if none exists, state
the selected stable baseline or that this is the first release. Do not infer the
baseline from a moving branch, tag spelling or creation time alone. Resolve the
baseline tag to its exact source commit, peeling annotated tags, and compare it
with the new frozen source SHA before dispatch. After the workflow creates the
new tag, resolve it too and verify that it identifies that same frozen source;
do not precreate the tag to prepare notes. Inspect the complete commit and file
comparison. If the comparison is not
an ordinary ancestor range, explain the divergence instead of presenting it as
a simple incremental update.

Write concise user-facing changes first, followed by relevant developer/testing
improvements, migration or breaking changes, and known limitations. Link the
exact GitHub comparison and supporting commits where helpful. Commit subjects
are discovery hints, not sufficient evidence: inspect the corresponding source
and tests. Exclude features already present in the baseline and commits added
after the frozen release source. Do not turn a timing goal into a measured
performance claim or claim native installation, update or live adoption from
build/feed tests alone. Retain macOS signing/notarization, Windows/Linux unsigned
status and `SHA256SUMS.txt` guidance.

After publication, retain the existing release body and complete asset inventory,
then update only the body of that exact release with the reviewed notes, for
example using `nice -n 15 gh release edit "$RELEASE_TAG" --repo cafeai/cafe-code
--notes-file "$REVIEWED_NOTES"`. The notes file is reviewed prose, never a shell
script assembled from untrusted commit text. Re-read the published body and
confirm the exact intended text and comparison, release ID/version/channel,
tag and matching branch commits, and unchanged asset IDs, names, sizes and
digests. A notes-only correction never moves a tag, creates another release,
rebuilds or replaces assets. Website deployment and main/dev alignment retain
their separate authority and verification requirements.

## Application version identity

The release version is a build input, not just a filename or native package
label. `scripts/build-desktop-artifact.ts` resolves and validates it once from
the requested packaging version, falling back to the server source package
version only when no override was supplied. It passes that resolved value as
`APP_VERSION` to its `yarn build:desktop` child and uses the same value for the
staged native package. Turbo already includes `APP_VERSION` in its hashed
`globalEnv`, so outputs built for another version cannot satisfy the same cache
key merely because the source files are unchanged.

The web build bakes `import.meta.env.APP_VERSION` into the renderer. The server
build bakes its shared `APPLICATION_VERSION` scalar into the backend, including
CLI version reporting and runtime/environment metadata. Changing an installed
process's environment cannot relabel either compiled component. Unoverridden
source builds retain their source-package version fallback.

Each successful web/server build emits an `application-build-version.json`
manifest from its actual emitted entrypoints and chunks. The manifest records
the component, application version, file byte counts and SHA-256 digests.
Packaging checks those bytes and the expected component/version before staging
and again after copying the staged backend and bundled web payload. Missing,
malformed, wrong-version, wrong-component or changed-byte evidence refuses
packaging, including `--skip-build`: that option permits verified reuse, not a
version override on stale outputs. Rebuild with the intended version rather
than editing a receipt or bypassing the check.

The server can prefer precompressed `.br` or `.gz` web assets. Every existing
compressed representation of a recorded payload must therefore decode to that
payload's exact byte count and digest, within the same bounded verification
budget. A current raw bundle beside stale, corrupt or oversized compressed
assets refuses packaging too; missing compressed assets may use the raw file.

Release packaging does not need to rewrite source `package.json` versions.
`scripts/update-release-package-versions.ts` remains an optional, deliberate
source-version update for maintainers who want one; it is not a mandatory
pre-release step or a substitute for versioned compilation. A source-version
change must be reviewed and qualified like any other source change.

These manifests close a local component-consistency gap. They do not
authenticate a publisher against someone who can change both build outputs and
receipts, replace normal CI/signature/checksum gates, or prove a successful
native install/update. See the [release-version decision](decisions/release-version-identity.md)
for the design and evidence boundary. Already published artifacts are immutable:
a repair to a published version such as `0.2.2` belongs in a separately
authorized, unused newer release, not replacement payloads under its old tag.

## Pre-release checklist

1. Obtain approval for the specific release and choose an unused stable or
   nightly version. Check the existing remote tag and GitHub release before
   selecting it; never force a tag or overwrite published assets.
2. Freeze the intended release source commit and create or verify the remote
   `release/<version>` branch at that exact commit before publication. Never
   reuse a different existing branch by moving or force-updating it. Normally
   dispatch from this matching branch, and bind both the actual event SHA and
   the workflow's prepared source SHA to the frozen commit; do not qualify a
   moving branch name against results from an older head. Updating `main` or
   aligning `dev` with it remains a separate, explicitly requested operation,
   not an automatic side effect of creating the release branch or publishing.
3. Use normal release mode for normal publication: require its exact-source
   reusable CI gate and all four release artifacts
   (`cafe-code-release-windows-x64`, `cafe-code-release-macos-arm64`,
   `cafe-code-release-macos-x64`, `cafe-code-release-linux-x64`). A build-only
   run or optional probe does not establish that normal CI passed.
4. Require one version across the native package, compiled renderer and compiled
   backend, with valid byte-bound component manifests. Retain the platform's
   existing signing/notarization, artifact source/identity, updater manifest,
   size and digest checks. Validate the Windows, macOS and Linux update-feed
   payloads for the selected channel; do not substitute a diagnostic archive
   or a result from a different source commit.
5. Let the workflow publish only the artifacts qualified by that exact run and
   commit. Verify that the matching release branch and tag both resolve to that
   source, and record the final version, branch, tag, source commit, workflow
   result and download/update artifacts. Do not silently rebuild or replace the
   published payload after verification. Real native upgrade/relaunch tests,
   when run, are separate qualification and must be reported as such.
6. Treat `CafeCode.sh` updates as separate scope and inspect the website's own
   repository and deployment configuration.
   This desktop workflow does not establish that website downloads, release
   text or deployment changed. Verify the website's actual release/deployment
   procedure and obtain its required authority before making those changes;
   do not assume a desktop tag deploys the website.
7. Complete the [release-notes procedure](#release-notes-and-post-publication-checks):
   publish reviewed differences from the exact preceding release source, keep
   platform/checksum and migration guidance, and verify the resulting public
   body without changing the already qualified tag, branch or payloads. A
   generic packaging paragraph or automatic commit list alone is not completion.

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

Settings → About must use the main process's explicit packaging identity to
choose its check. Packaged installs check the release updater and report its
checking, up-to-date, available or failed state; source builds retain the Git
branch diagnostic. A missing Git checkout, a version string or disabled update
eligibility is not evidence of which runtime is installed. Legacy update-state
messages without explicit runtime identity remain unknown rather than silently
selecting the wrong check. This presentation metadata grants no download or
installation permission: those operations retain the native eligibility gates
and explicit user confirmation described below.

Both source and packaged status queries preserve a newer native event over an
older initial read at the actual cache-write boundary. Read receipts stay private
to the renderer and bind the exact bridge, query, revision and cancellation
signal; retired listeners and replies cannot publish into the current view.
These display-ordering guards do not trigger another update check or grant
download, installation or provider authority.

The same update action as the sidebar remains available in About even when that
sidebar is hidden or its notification was dismissed. Checking alone never
downloads or installs a release. This renderer repair cannot update an older
installed binary: an affected app may need its existing native application-menu
check or a manual download of a separately published newer release first.

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
`dev`; other branches are ignored without fetching. They do not consume GitHub Release manifests
and cannot install packaged updates. Packaging identity, not the diagnostic logging flag,
selects between these two paths.

Required updater tests cover both source branches, ignored branches, packaged eligibility,
the startup/poll schedule, Settings routing, completed initial-read/event ordering,
retired bridge/unmount refusal and explicit user actions. An isolated HTTP integration
fixture also runs the installed Electron Updater metadata engine against an owned loopback server:
actual GitHub feed parsing, platform manifest selection, stable/nightly version decisions and
recovery after a failed manifest check. It refuses artifact requests and asserts zero automatic
download or installation. This exercises metadata discovery, not live GitHub/TLS reachability,
Electron networking, downloaded payload integrity, native signatures or a real installer upgrade;
those remain separate release/native qualification.

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
artifact identities are sealed. Release verification checks the ZIP app without launching it.

The separate `reliability.yml` workflow runs optional native runtime/install checks
on disposable CI runners. These checks keep Chromium sandboxing and the real
safe-storage round trip enabled. Linux opts into configuring only its private extracted
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
Each synthetic credential trusts the exact executable through its application ACL
and admits its native signing partition alongside the owning Apple tool: the
`codesign` CDHash for ad-hoc artifacts or the verified Developer ID team for signed
artifacts. The legacy application ACL alone leaves an `apple-tool:` partition
that blocks Electron's native key access.
Missing or ambiguous executable identity refuses the launch, and partition setup
failure still deletes the private keychain. This applies to both ad-hoc and
Developer ID signed artifacts without modifying their signatures.
These options are scoped to their respective artifact steps; ordinary launches
and local smoke commands retain their existing OS policy. No private signing key,
provider account or existing keychain contents participate in this setup.

The Windows smoke sends NSIS's final `/D=` tail verbatim, preserving spaces
without CRT-style quoting, as required by the [NSIS command-line contract](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage).
Bootstrap failures retain exit code `1`; the error dialog uses its silent-mode
default so unattended installs can fail without waiting for a click.
