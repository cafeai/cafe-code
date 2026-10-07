# Cua Driver release boundary

Cafe's interim Linux virtual desktop implementation has been removed. The
replacement uses local Cua Driver on **macOS**. This directory establishes the audited
release pin, the local source patch and notices. The Cafe-owned controller and
session-scoped MCP bridge provide tools to Codex and Claude. No Cua Spaces, Fleet, account, cloud SDK, paid endpoint,
models or installer scripts have been added to Cafe.

The first native-control release targets **Codex and Claude Code**, as selected
by the user. Both receive the same Cafe-owned local control catalog through
provider-scoped session configuration, preserving their existing permission
policies. Additional providers are outside this initial scope. Existing Cafe
management and scheduling MCP integrations remain independent.

**Unmodified release archives: reviewed with findings; not approved for execution.**
`release.json` retains `audit.integrationApproved=false`. Native integration
instead admits the exact reviewed source plus `local-only.patch`, as recorded in
`build.json`, and a matching executable hash. Original archives cannot be used
by the launcher or packaging stager.

## Mac integration and build

`corepack yarn build:desktop --force` prepares the reviewed source runtime before
the Turbo cache lookup. An existing matching runtime is verified and reused
offline. First preparation requires Git and Cargo/Rust plus Apple's command line
tools; it fetches the exact source commit, checks/applies the patch and builds
with the patched locked dependency graph. `corepack yarn cua:prepare --force`
deliberately rebuilds the source. No upstream installer runs and no user Cua or
provider profile is edited.

The source patch removes the Cua telemetry crate and makes driver telemetry
compile-time disabled. It upgrades `anyhow` to 1.0.103, `event-listener` to 5.4.2,
`lru` to 0.18.2 and `memmap2` to 0.9.11. The reviewed Mac normal dependency graph
excludes the affected XML and atomic-polyfill paths. The informational
`ttf-parser` 0.21.1 maintenance finding is retained through fontdue's cursor
overlay; Cafe unconditionally disables the overlay and exposes no font/overlay
configuration. Its maintenance status remains an upgrade-review item.

The runtime lives in ignored `runtime/darwin-<arch>` with source/patch/binary
hash provenance. Artifact packaging stages only matching verified bytes and
notices at `resources/cua-driver`, outside ASAR. No runtime is admitted on other
platforms. Universal artifacts are not admitted until a separately reviewed
universal runtime is available.

The Mac signing hook delegates electron-builder's ordinary signer, records
the helper's final Mach-O hash and re-seals
only the outer app with its original signing certificate, entitlements and
runtime flags. It verifies the helper signature and signing-team relationship
before updating provenance, and finishes before electron-builder notarizes
the app. Unsigned builds skip this signing hook. An isolated opt-in ad-hoc
fixture exercises the pinned builder's real signing pipeline and qualifies
the hash/seal/notarization ordering; Developer ID and real notarization remain
release-CI checks.

Electron launches the helper directly, with a private socket, stdin parent
liveness, fixed standard permission mode and no overlay. Telemetry/update opt-outs
reach this actual child. Its HOME and Cua state directories are private temporary
directories, so ambient Cua history, extensions or preferences are not adopted.
Provider transports use copied standalone Node/Electron stdio bridges and
session-only private capability files; no provider-global configuration is
changed. Mac startup enables the helper by default. The Settings switch controls
app-wide availability; the composer **Computer use** button enables or disables
access for its local Codex/Claude chat. Chat choices last for the app session and
default on. Only trusted renderer IPC can change them, and the host enforces
disabled chat access before dispatch even with an already-connected provider.

After merging and building, open **Settings → MCP → Local desktop control** in
the local Mac desktop app. Cafe prompts once per launch for missing permissions;
the composer enable action and **Set up permissions** in Settings can reopen it.
Choose the missing permission to open its macOS settings, then approve the actual
Cafe app's Accessibility and Screen Recording in macOS System
Settings when required. Start a new Codex/Claude session or normally stop/resume
an existing session to attach the tools. Begin with `health`, observe before
acting, and use a disposable window for initial input testing. Never repeat an
input whose completion is uncertain.

Cafe's public `health` tool and **Check permissions** button call the native
`health_report` tool. Its versioned report includes Accessibility and Screen
Recording status without prompting or capturing the screen. A degraded report
can describe missing grants; it is distinct from a tool execution error. The
native qualification checks both the error flag and the structured report,
including the permission entries.

Native health/screen-size qualification is opt-in:

```sh
CAFE_CODE_CUA_NATIVE_E2E=1 corepack yarn workspace @cafecode/desktop exec vitest run --config ../../vitest.config.ts src/nativeControl/NativeDaemon.e2e.test.ts
CAFE_CODE_CUA_SIGNING_E2E=1 corepack yarn workspace @cafecode/desktop exec vitest run --config ../../vitest.config.ts src/nativeControl/CuaSigning.e2e.test.ts
CAFE_CODE_MCP_BRIDGE_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CafeMcpBridge.e2e.test.ts integration/NativeControlBridge.e2e.test.ts
```

The bridge fixture uses a synthetic controller and no real provider or paid
inference. Actual screenshot/input permission qualification is a user-initiated
Mac test after grants; a passing health test alone does not establish that.

`release.json` is the single production pin for version, immutable source commit,
platform archives, exact byte lengths, SHA-256 hashes and signing identity.
Archive downloads are explicit development operations, outside ordinary builds.
The archives contain native CLI/SDK payloads; fetching them does not install,
extract, execute or configure anything. Downloaded payloads belong in ignored
`.explorations/` storage, never source control.

## Fetch the pinned archive

Use the repository's pinned Node and Corepack Yarn:

```sh
corepack yarn cua:fetch --target darwin-universal
```

The remaining target names are `linux-arm64`, `linux-x64`, `win32-arm64` and
`win32-x64`. The command saves a fresh archive under
`.explorations/cua-driver/download-*`, verifies its size and SHA-256 before
writing, and refuses to overwrite existing files. It does not use the upstream
installers, modify PATH, change provider configuration or start a daemon.

## Upgrade deliberately

```sh
corepack yarn cua:review --version 0.34.0
```

Substitute the exact proposed release version. This fetches release/tag metadata
and saves an **unaudited candidate**, leaving `release.json` unchanged. A
candidate's hashes come from the upstream release API and are discovery data;
they are not evidence of a completed audit. Do not copy a candidate into the
production pin until the review is complete.

For each upgrade, review the immutable source diff, license/notices, CLI/SDK
contract, telemetry/update behavior, native permission attribution, session
cleanup and artifact contents. Verify every archive against its detached
Sigstore bundle using the exact certificate identity and issuer recorded in the
pin, and verify the signed `SHA256SUMS` manifest. A maintainer-provided Cosign
verifier can perform the signature check:

```sh
cosign verify-blob \
  --bundle <archive>.sigstore.json \
  --certificate-identity <release.json certificateIdentity> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  <archive>
```

After review, update the version/commit/artifact hashes together in
`release.json`, refresh this audit and the notices, and qualify the native
integration on each host before enabling the new release. The exact version
appearing in a test fixture identifies that fixture, not a second runtime pin.

## Audit: 0.34.0, 2026-10-07

The findings below describe the original upstream source and release archives.
The Mac source-build remediation and integration qualification are recorded
above; the original archives retain their unapproved disposition.

Reviewed source: [`b0968e1b12834e485dda68789541a3cc57664a9f`](https://github.com/trycua/cua/tree/b0968e1b12834e485dda68789541a3cc57664a9f/libs/cua-driver).
Upstream's [release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.0)
was published on October 5. It explains that the GitHub prerelease label prevents
the monorepo's repository-wide Latest pointer from switching products; the plain
SemVer is published on the stable package channels.

The bounded audit covered the Driver entry points, default Rust features,
dependency manifest/lockfile, generated Node SDK boundary, embedded-host
lifecycle, session ownership/cleanup, authorization, telemetry/update paths,
extension installation and native release workflow. It is not an exhaustive
review of every dependency or a guarantee that the binaries contain no defects.
No upstream installation script was executed, no permissions were granted and
no live desktop/provider operations were exercised.

An OSV/RustSec query on October 7 checked all **621 registry package versions**
in the tagged Cargo lockfile. It returned **eight advisory records across seven
packages**:

| Locked package          | Advisory classification                                                                                                                                                  | Remediation or review                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `anyhow` 1.0.102        | [Unsound error mutation](https://rustsec.org/advisories/RUSTSEC-2026-0190.html)                                                                                          | Fixed in 1.0.103; review contextual `downcast_mut` use.                    |
| `event-listener` 5.4.1  | [Unsound thread transfer](https://rustsec.org/advisories/RUSTSEC-2026-0221.html)                                                                                         | Fixed in 5.4.2; review the tagged stack-listener path.                     |
| `lru` 0.18.1            | [Unsound panic cleanup](https://rustsec.org/advisories/RUSTSEC-2026-0253.html)                                                                                           | Fixed in 0.18.2; requires specific panicking-key/unwind conditions.        |
| `memmap2` 0.9.10        | [Unsound range pointer arithmetic](https://rustsec.org/advisories/RUSTSEC-2026-0186.html)                                                                                | Fixed in 0.9.11; review the affected range APIs.                           |
| `quick-xml` 0.39.4      | [CPU denial of service](https://rustsec.org/advisories/RUSTSEC-2026-0194.html) and [allocation denial of service](https://rustsec.org/advisories/RUSTSEC-2026-0195.html) | Fixed in 0.41.0; reached through Wayland generation and `zbus_xml`.        |
| `atomic-polyfill` 1.0.3 | [Unmaintained](https://rustsec.org/advisories/RUSTSEC-2023-0089.html)                                                                                                    | Replace or document target/feature exclusion.                              |
| `ttf-parser` 0.21.1     | [Unmaintained](https://rustsec.org/advisories/RUSTSEC-2026-0192.html)                                                                                                    | Replace or explicitly review its bounded font inputs and maintenance risk. |

These are **lockfile matches, not proof of exploitability in the released
binaries**. The lock graph includes target, development and generation-only
dependencies. Conservative graph inspection connects the matches to Driver
through its platform, Rego policy and cursor-rendering dependencies; exact
compiled-feature/API reachability is not established. A bounded search of the
Driver's own Rust source did not find the affected `downcast_mut`, mapping-range
or tagged-listener calls, but that does not prove absence inside transitive
dependencies. Do not suppress the findings on that basis. Prefer a corrected
upstream release or a separately pinned, rebuilt and qualified dependency patch
before shipping; retain a precise reachability analysis for any accepted
informational finding.

- All five native archives matched their pinned sizes and SHA-256 digests.
  Their detached signatures and `SHA256SUMS` verified with Cosign 3.1.3, the
  public Sigstore trust root, the exact tagged `cd-rust-cua-driver.yml` workflow
  identity and the GitHub Actions OIDC issuer. This establishes publisher/artifact
  identity, not absence of malicious or defective code.
- The universal macOS executable passed `codesign --verify --strict` and
  reported `cua-driver 0.34.0` with telemetry and update checks disabled. This
  is executable/version evidence only, not GUI permission or input qualification.
- Driver is MIT-licensed. The raw binary archives omit notices, so Cafe retains
  the upstream MIT license and third-party notices here. The optional Node
  compatibility runtime is MPL-2.0-derived; its corresponding-source notice is
  retained separately. No perception models or model licenses are incorporated.
  Review the full transitive redistribution obligations before packaging native
  payloads in a public Cafe artifact.
- The npm SDK's registry signatures and tarball integrity also verified. Its
  SLSA statement names source commit
  `73387960d56a99dd2f607cef9b2bdae57e373217`, rather than the binary release tag's
  commit. The Driver diff between those commits changes only two installer
  download defaults. The npm SDK is **not** an installed Cafe dependency in this
  change; do not infer native compatibility from matching version numbers alone.
- Local Driver does not require a Cua account or model service. The CLI still
  contains optional telemetry, update and extension-download code. Cafe has not
  enabled any of it. Using the upstream binary cannot support a claim that those
  code paths have been physically removed.
- Routine telemetry is enabled by default and posts to PostHog. Force
  `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `CUA_TELEMETRY_ENABLED=0` in every future
  child launch, along with `DO_NOT_TRACK=1` and `CUA_TELEMETRY=0` for shared
  opt-out policy. Startup update checks require
  `CUA_DRIVER_RS_UPDATE_CHECK=false`. The environment policy is exported in the
  release tooling for verification and tested on Cafe's direct Mac helper launch.
- **Embedded SDK limitation:** the 0.34.0 embedded host's environment allowlist
  passes both telemetry flags but drops the update-check flag, `DO_NOT_TRACK`
  and `CUA_TELEMETRY`. Merely passing the policy object to that SDK does not
  establish Cafe's intended offline startup behavior. Resolve and test that
  boundary before using the generated host; do not edit the user's Cua profile
  as a workaround. [Audited host source](https://github.com/trycua/cua/blob/b0968e1b12834e485dda68789541a3cc57664a9f/libs/cua-driver/rust/crates/cua-driver-sdk/src/embedded.rs).
- The standard MCP catalog includes optional host tools such as
  `install_extension` and `check_for_update`. The replacement must expose an
  explicit local-control catalog, excluding download/update/remote facilities;
  environment flags alone are not a catalog policy or network sandbox.
- The macOS embedded daemon must be launched directly by the responsible GUI
  host, with private IPC and a parent-liveness pipe. A detached provider daemon
  cannot substitute for Cafe's TCC identity. The host's grants and helper
  generation require separate qualification.
- Session cleanup can return `session_cleanup_pending` or
  `session_cleanup_partial`. Transport cancellation does not prove an action
  stopped; wait for acknowledged cleanup before releasing native control.
  Never replay uncertain actions. Standard authorization is the default;
  unrestricted mode and existing browser-profile grants require separate
  explicit trusted policy.
- Linux support varies by display server/compositor. The existence of an
  archive is not proof of support for every user's host. Native permission,
  capture, input and cleanup qualification remains outstanding on all hosts.

The audit evidence and downloaded source/artifacts remain in ignored
`.explorations/cua-audit-0.34.0/`. The production manifest and notices are small,
reviewable text files; neither proprietary desktop-app code nor Cua SaaS packages
are incorporated into Cafe.
