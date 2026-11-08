# Cafe Code P1 Release Remediation Plan

Date: 2026-10-14
Last updated: 2026-10-20 14:17:11 JST (UTC+0900)

Resolve the seven P1 findings from the October release review before publishing
a stable release. Each change below has an implementation boundary, regression
coverage, and a condition for closing the finding. The critical dependency
upgrade is separate from the seven application and release fixes. The source
implementation is now in place; the status below separates local regression
verification from native release-candidate qualification.

This plan supplements the historical
[release readiness worklist](release-readiness-worklist.md). Its scope preserves
the existing unsigned release policy, supported artifact matrix, provider
permissions, process ownership rules, and repository toolchain. Provider SDKs
and native executables retain their independently reviewed versions.

## Implementation status

All seven fixes have source changes and regression coverage. The release gate
remains deliberately blocked until its exact candidate passes all native checks
and the full advisory audit. Local macOS results do not qualify Windows/Linux
installer behavior or published artifacts.

| Finding               | Implementation                                                                                                                 | Qualification                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 1 Desktop trust    | Exact renderer origin, live main frame, surface role, navigation/redirect guards, document revision fencing                    | IPC, window and dictation regressions locally; native hosts remain gated in CI                                                                                         |
| P1 2 HTTPS provenance | Process-private capability plus native peer; stripped forwarding headers; one cookie/static/API transport policy               | Spoof/restart/peer tests, real WSS sibling and external route refusal                                                                                                  |
| P1 3 HTTP ingestion   | Streaming byte/chunk/deadline limits, aggregate reservations, authenticated/rate-bounded debug events, safe OTLP failures      | Native HTTP overflow/deadline/disconnect and authenticated router tests                                                                                                |
| P1 4 Web Push         | Exact session ownership, private migration, restart/revocation/expiry reconciliation, shared revocation/admission fence        | Synthetic transport, migration/permissions, revocation and persisted-owner tests                                                                                       |
| P1 5 Managed install  | Reviewed offline provider closure, exclusive generations, guard-owned publication/rollback, NSIS error propagation             | Synthetic preparation and integrity tests; real x64/arm64 archive staging locally; native PowerShell failure/interruption and installed NSIS gates added to Windows CI |
| P1 6 Release smoke    | Shared manifest/lockfile patch discovery and complete staging inputs                                                           | Isolated immutable release smoke passes                                                                                                                                |
| P1 7 Release gates    | Reused complete CI/reliability at exact SHA, artifact readiness and byte evidence, candidate feed preflight before publication | Workflow and evidence regressions locally; hosted tag/artifact execution pending                                                                                       |

The full dependency audit currently reports **zero critical** advisories after
`proxy-addr` 2.0.8. Three high, one moderate and one low advisory remain in the
previously recorded packages. None is suppressed by the new release gate.

At the remediation checkpoint recorded here, the Windows installer staged Codex
0.160.0 and Claude Code 2.1.295 from exact npm archive identities, including both
Windows native dependency sets. See the [canonical managed-provider manifest](../packaging/managed-providers/manifest.json)
for the current identities. Installation performs no registry request
or package-manager execution. The Node preparation child cannot select a runtime
or write preferences; the hidden PowerShell process retains the OS file guard
through publication. A killed preparation leaves only an unselected generation.
The selected immutable generation uses installer repair for updates; historical
`current` layouts remain readable only when no activation record exists. Native
Windows qualification uses `node scripts/windows-managed-installer-smoke.ts`
with `CAFE_CODE_WINDOWS_MANAGED_INSTALLER_E2E=1`, isolated profiles and synthetic
preparation, followed by the separate real artifact installer/runtime smoke.

HTTP control JSON is bounded to 64 KiB, debug events to 8 KiB, OTLP/MCP and
orchestration JSON to 1 MiB, with a ten-second absolute read deadline. At most
32 ordinary readers reserve a combined 32 MiB of payload capacity; binary
attachments and visualization transport keep their dedicated admission rules.
Debug accepts at most 20 events per session and 120 overall per minute, with
at most 1,024 active bookkeeping entries. Logged fields are finite event names,
sequence numbers and allowlisted boolean observations; unknown payload fields
never reach the logger.

Web Push's final local initiation shares the session-revocation fence, released
before waiting for the remote transport. A push already accepted by that
transport cannot be recalled. Unowned legacy subscriptions require browser
re-registration; the private migration retains VAPID identity and preserves
unreadable state as recovery evidence. Writes enforce the same 1 MiB UTF-8
storage ceiling as startup reads, retaining the last restartable state when
registration would exceed that budget.

## Implementation order

| Order | Change                                              | Dependency                                        | Completion evidence                                                                                  |
| ----- | --------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0     | Upgrade every currently critical dependency         | Current full dependency audit                     | No critical advisory; exact installed and locked versions; security regression and repository checks |
| 1     | Repair release smoke, P1 6                          | None                                              | Clean isolated immutable install and complete release smoke                                          |
| 2     | Restrict desktop navigation and IPC, P1 1           | None                                              | Untrusted origin, surface, frame, and document rejection                                             |
| 3     | Authenticate HTTPS proxy provenance, P1 2           | None                                              | Direct spoof rejection and real sibling HTTP/WebSocket qualification                                 |
| 4     | Bound and authenticate HTTP ingestion, P1 3         | P1 2 for trusted transport and client identity    | Native chunked-body, deadline, authentication, rate, and redaction assertions                        |
| 5     | Bind Web Push to sessions, P1 4                     | Existing session identity and revocation services | Revocation, expiry, restart, migration, and private-storage coverage                                 |
| 6     | Make managed-provider bootstrap transactional, P1 5 | Reviewed provider release identities              | Synthetic failure matrix and disposable native installer qualification                               |
| 7     | Gate tagged publication, P1 7                       | All preceding changes and green native artifacts  | Every required job qualifies the exact tag SHA before publication                                    |

Keep changes reviewable as separate commits using the repository's required
`type(scope): summary` subjects. Re-run the applicable checks after each software
change. A completed dependency update does not close any of the seven P1 items.

## Critical dependency upgrade

The October 14 full audit identifies one critical package: `proxy-addr` 2.0.7,
through the MCP SDK's Express dependency. The
[upstream advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
identifies 2.0.8 as the patched version. Short IPv6 trust subnets could otherwise
match unrelated IPv4 peers. Cafe's own HTTPS provenance finding is a separate
application defect and still requires P1 2.

- Set the root security resolution to `proxy-addr: ^2.0.8` and lock the reviewed
  2.0.8 release. Review the complete lock diff and retain the existing parent
  SDK, Express, `forwarded`, and `ipaddr.js` versions.
- Extend the existing security-floor policy to reject every vulnerable locked
  copy. Exercise the installed implementation against the formerly overbroad
  `::ffff:10.0.0.0/8` and `::/1` ranges, and preserve correct private IPv4 and
  IPv4-mapped `/104` behavior.
- Verify the fetched release identity through Yarn's checksums and the npm
  release metadata, then repeat immutable installation and full audit. Resolve
  any additional critical package discovered by that audit before completing
  this work. Preserve the audit's other severities and findings.

The initial audit also reports high advisories in the MCP SDK,
`http-cache-semantics`, and `source-map-js`, a moderate advisory in `sprintf-js`,
and a low advisory in KaTeX. The October 15 follow-up updates the MCP SDK to
1.32.1 in source, scripts and the staged desktop runtime; KaTeX to 0.18.11 across
the direct and Mermaid/rehype branches; `http-cache-semantics` to 4.3.0; and
`source-map-js` to 1.2.2. `global-agent` 4.1.3 removes the obsolete
`roarr -> sprintf-js` branch, for which no patched formatter release exists.
The unfiltered recursive audit then reports no findings, without changing its
severity coverage or excluding packages. The MCP OAuth-client advisory excludes
SDK-built servers; Cafe has no SDK OAuth client provider or stored client tokens
to migrate in these calling paths.

The lock update retains `@hono/node-server` 1.19.17 within the new SDK's supported
v1/v2 union instead of adopting an unrelated major. Nine new tarballs match their
npm SHA-512 integrity and their advertised registry signatures verify against
the registry's public keys. Full Sigstore certificate-chain/transparency-log
verification is not claimed. The actual `@electron/get` consumer's bootstrap,
proxy routing and `NO_PROXY` bypass are exercised with two isolated loopback
servers; native packaging and the existing MCP/Markdown/Mermaid tests still
qualify the exact candidate independently of the dependency audit.

## P1 1 Restrict desktop navigation and IPC

Implementation starts in
[DesktopIpc.ts](../apps/desktop/src/ipc/DesktopIpc.ts),
[DesktopWindow.ts](../apps/desktop/src/window/DesktopWindow.ts), the preload
entry points, and the IPC method registrations. Reuse the exact-origin approach
already present in `TrustedAudioPermissionPolicy.ts` and the held document checks
used by image export.

1. Replace the broad loopback/file URL predicate with trust records containing
   the expected application origin and surface role for each native webContents.
   Authorize the live top-level document and the method's surface role on every
   sync and asynchronous IPC request.
2. Register main-frame navigation and redirect guards before loading the main
   window. Permit the bootstrapped application origin and intended same-origin
   routes. Reject other ports, hosts, schemes, local files, and untrusted
   redirects. Keep renderer and backend origins explicit in development mode.
3. Keep auxiliary dictation, inert startup, Mermaid, visualization, and export
   surfaces on their existing narrow capabilities. Audit auxiliary trust
   registration so a surface with a small preload cannot acquire the main
   window's full method set. Preserve sandboxing, context isolation, and the
   existing audio permission policy.
4. Revalidate native document identity after asynchronous dialogs or I/O before
   publishing a privileged result or mutation. Preserve existing delayed-save
   checks rather than introducing a second inconsistent identity policy.

Cover alternate loopback ports, loopback spelling variants, `file:` and `data:`
URLs, cross-origin redirects, subframes, destroyed senders, auxiliary surfaces,
and navigation while a delayed operation is pending. Successful ordinary main
window operations and same-origin routing must still work.

**Close when:** an untrusted replacement document cannot read bootstrap/session
secrets, invoke native actions, change settings, or control updates. Qualify
native navigation on each supported desktop host as well as isolated IPC tests.

## P1 2 Authenticate HTTPS proxy provenance

Implementation touches
[httpsSiblingServer.ts](../apps/server/src/httpsSiblingServer.ts),
[http.ts](../apps/server/src/http.ts),
[auth/http.ts](../apps/server/src/auth/http.ts), and WebSocket admission.

1. Create one private process-lifetime proxy capability shared by the sibling
   and backend. Stamp it only on requests from the sibling and require it
   together with the expected native peer before trusting forwarded metadata.
   Strip inbound provenance headers before stamping. Keep this capability out
   of persisted settings, URLs, argv, diagnostics, and forwarded provider data.
2. Centralize trusted transport classification. Use that result for HTTPS
   bootstrap, cookie names and flags, authentication, and WebSocket upgrade
   handling. Header presence alone must never establish TLS provenance.
3. When HTTPS is enabled for external access, reject external cleartext
   sensitive API and WebSocket requests before reading credentials or bodies.
   Retain the minimal certificate/bootstrap response and the explicitly local
   desktop connection. Preserve intentionally configured HTTP-only operation.
4. Preserve the distinction between a direct local request and an external
   request relayed over loopback. Session scheduling and visualization bridges
   must continue to reject externally relayed traffic despite its local socket.
   Attribute any forwarded client address only through authenticated metadata.

Test missing, wrong, replayed-after-restart, and externally supplied provenance;
both legacy marker headers; cleartext credential requests; cookies; IPv4/IPv6;
actual sibling requests; and real WebSocket upgrades. Do not treat a cookie's
`Secure` attribute as proof that its incoming request was encrypted.

**Close when:** direct clients cannot impersonate the HTTPS sibling, and all
external sensitive routes consistently enforce the configured transport policy.

## P1 3 Bound and authenticate HTTP ingestion

Inventory every body-bearing HTTP route, including authentication, Web Push,
branding uploads, OTLP, debug ingestion, MCP, and orchestration HTTP. Reuse the
bounded readers already used by file attachments and visualization transport.

1. Define a shared bounded byte reader and route-specific budgets. Start with
   explicit reviewed budgets for small control JSON and diagnostics; preserve
   the existing attachment/image/MCP limits. No route should inherit unlimited
   aggregate materialization. Reject oversized declared lengths early and
   enforce the same byte ceiling for chunked or absent-length delivery.
2. Authenticate debug ingestion before reading its body and retain the explicit
   server debug switch. Require an allowlisted schema with finite strings,
   arrays, nesting, and event names. Bound rate-limit bookkeeping and apply
   per-session and aggregate work limits without trusting forwarded addresses.
3. Add bounded body-read deadlines and retire interrupted or oversized native
   requests safely. JSON parsing and validation happen only after byte admission.
   Keep HTTP upload policy separate from existing WebSocket stream/frame limits.
4. Remove raw debug/OTLP bodies and secret-bearing decode causes from logs and
   telemetry. Record safe error codes, bounded sizes, and fixed counters. Ensure
   configured collector credentials and rejected input cannot reach diagnostics.

Use real scoped Node HTTP clients for chunked overflow, malformed input, slow
delivery, early disconnect, concurrent requests, and keep-alive behavior. Add
secret-shaped fixtures across logs, traces, and public errors. Verify legal
boundary-sized requests succeed and unauthorized bodies never reach a decoder.

**Close when:** every body route has an enforced budget, debug ingestion requires
authentication, and rejected input cannot cause unbounded work or raw-body logs.

## P1 4 Bind Web Push to authenticated sessions

Implementation starts in
[WebPushNotifications.ts](../apps/server/src/notifications/WebPushNotifications.ts),
its HTTP routes, and `SessionCredentialService`. Use existing session identity,
active-session validation, and the session change stream without creating an
authentication/notification layer cycle.

1. Persist the authenticated session owner with each subscription. Pass the
   authenticated context through registration, locale updates, unsubscribe, and
   delivery. An endpoint/key pair alone cannot transfer ownership between sessions.
2. Remove subscriptions on session revocation and expiry, reconcile owners at
   startup, and validate the active owner before enqueueing a notification. Retain
   existing thread and notification policy. A disconnected but still valid
   browser session can continue receiving authorized background notifications.
3. Store VAPID and subscription secrets privately. On POSIX enforce private
   directories/files and verify ownership and unsafe links; preserve the
   installing user's inherited ACL and writable cleanup behavior on Windows.
   Repair unsafe legacy permissions through the established private-write path.
4. Migrate unowned subscriptions without guessing who owns them. Require fresh
   authenticated registration; preserve the VAPID identity only through a safe
   private migration. A failed migration must retain recoverable evidence and
   disable delivery rather than publishing an ambiguous owner.

Web Push initialization failures are isolated from core backend startup. The
unavailable instance refuses every push API and starts no delivery consumers,
key generation or storage retries. A fixed phase and safe explanation distinguish
read/security refusal, decode failure and reconciliation failure without exposing
paths or private state. The failed file/identity remains recovery evidence;
interruption and defects are not converted into this optional-service fallback.

Test exact-owner changes, another session's endpoint, revocation, bulk revocation,
expiry, restart, malformed storage, permission repair, and registration/delivery
races with a synthetic push transport. Already accepted external push deliveries
cannot be recalled; establish the final local delivery authorization boundary
and document that transport limitation accurately.

**Close when:** no new delivery is admitted after its owner's revocation or
expiry, and no unowned subscription or permissive secret file survives migration.

## P1 5 Make managed-provider bootstrap transactional

Use the Windows-specific requirements in `AGENTS.md` before implementation.
Primary files are the managed-runtime installer script, `installer.nsh`,
`managedProviderRuntime.ts`, and desktop artifact staging.

1. Publish a reviewed managed-runtime manifest containing exact provider
   versions, archive/package integrity, architecture, and required runtime
   identity. Include the platform-specific dependency closure in reproducibility
   checks. Remove mutable package selection from first-install bootstrap.
2. Install and validate into unique versioned staging directories. Keep the
   currently selected runtime intact until the replacement is complete. Use a
   recoverable activation record or another verified transaction compatible with
   native file locking; do not delete `current` before a successful replacement.
3. Persist bundled-mode settings only after success. Preserve existing settings,
   working runtimes, and running provider processes on failure. Reconcile an
   interrupted installation from explicit transaction state, with bounded cleanup
   that cannot delete replacement entries or unrelated user files.
4. Return failure for every unsuccessful required provider install, propagate it
   through NSIS, and present a clear repair/retry outcome. Define partial success,
   rollback, repair, update, and uninstall behavior. Keep the installer's existing
   per-user paths and updated-install bootstrap exclusion.

Keep macOS/Linux and system-provider selection unchanged. Native ownership,
permissions, detached-process cleanup, and provider enforcement remain governed
by their current policies. Use scoped synthetic executables for unit failure
coverage and disposable native Windows runners for installer qualification;
provider-backed cases remain explicit opt-in tests with isolated profiles.

**Close when:** offline, integrity, extraction, launch, activation, interruption,
and settings-write failures leave a truthful installer result and preserve the
last working configuration. Successful install and repair select the exact
reviewed bytes on native Windows without administrator or symlink privileges.

## P1 6 Repair release smoke inputs

[release-smoke.ts](../scripts/release-smoke.ts) omits
`.yarn/patches/effect-vitest.patch` from its isolated workspace. Its full immutable
install therefore fails before release checks run. The focused production
runtime install passed separately; do not conflate these two install graphs.

1. Include every patch referenced by the copied root manifest and lockfile.
   Consolidate the shared staging input policy with
   `build-desktop-artifact.ts`, allowing explicit additions for each fixture.
   Validate relative paths and reject absent inputs before invoking Yarn.
2. Test the exact current patch set, a newly referenced patch, and a missing
   referenced patch. Preserve both existing Effect patches, version rewriting,
   lockfile immutability, and updater-manifest checks.
3. Keep the registry-backed immutable install in the explicit release command.
   Do not move live registry or provider assumptions into deterministic defaults.

**Close when:** `corepack yarn release:smoke` completes from an isolated workspace,
and a missing required patch produces an immediate actionable failure.

## P1 7 Gate publication on the exact release candidate

Refactor `.github/workflows/release.yml`, the reusable CI boundaries, and the
reliability workflow's explicit ref selection. Scheduled reliability runs should
retain their existing branch and cadence; a release invocation must pass the
immutable tag SHA instead of inheriting a hard-coded development branch.

1. Require formatting, lint, type checking, default tests, release smoke, and a
   full dependency audit without advisory/package/severity exclusions on that
   SHA. Preserve manual coordinated review for protected dependencies. Existing
   noncritical advisories must also be resolved before the full gate can pass.
2. Run the existing full Linux browser suite and native macOS/Windows focused
   subsets with unchanged worker caps, input isolation, and deadlines. Run the
   isolated parser and Effect cancellation qualification after default tests.
3. Qualify each supported built artifact before publication: Windows x64 NSIS,
   macOS arm64/x64 DMG/ZIP, and Linux x64 AppImage. Require fresh install, backend
   and renderer readiness, quit/relaunch, cleanup, and relevant recovery/update
   checks using isolated profiles. Qualify updates through a controlled local
   feed before publication and retain the public-feed check afterward.
4. Bind validated artifacts, updater manifests, checksums, and source SHA to the
   publication job. Make all required jobs direct or transitive dependencies of
   publication; failure, cancellation, or a skipped required job must block it.
   Retain the intentionally unsigned policy and current least-privilege jobs.
5. Document handling of a post-publication feed-probe failure and how to withdraw
   or replace a broken release. Live credential-backed provider canaries remain
   protected opt-in workflows, separate from credential-free default checks.

Test workflow/ref policy with synthetic inputs and native artifacts on disposable
runners. A previous green branch run, local Mac result, or successful source
build cannot substitute for qualification of the tagged native artifact.

**Close when:** the exact published artifact set has passed every required gate,
and no tag can publish through an omitted, skipped, stale, or failed check.

## Verification and release exit criteria

For each implemented software change, complete the relevant focused tests and
the required repository checks on the pinned standalone Node and Corepack Yarn:

```sh
corepack yarn install --immutable
corepack yarn fmt
corepack yarn lint
corepack yarn typecheck
corepack yarn test
```

Run applicable browser, parser, cancellation, release-smoke, full dependency
audit, and native artifact checks before the final forced desktop build:

```sh
corepack yarn build:desktop --force
```

Close a P1 only with its regression evidence and documentation update, including
the applicable `AGENTS.md` architecture or Windows section. Verify migration
recovery and compatibility on the native hosts affected by the change. Update
the historical worklist to reflect completed current findings without reviving
removed analytics or already implemented SQLite/TLS behavior. Keep a protected
source snapshot for release qualification so concurrent edits cannot mix results.

The stable-release exit criteria are all seven P1 items closed, no critical
dependency remaining, a clean full advisory gate, and all required checks green
for the exact release SHA and artifact identities. Promotion and any push to
`dev` retain the user's existing confirmation requirement.
