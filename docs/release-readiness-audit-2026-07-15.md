# Cafe Code Release-Readiness Audit

Date: 2026-07-15
Repository version: `0.0.51`
Scope: all 1,233 Git-tracked repository files
Assessment: **No-go for a public stable release**

## Executive Summary

Cafe Code has a surprisingly substantial foundation for an alpha: the provider daemon, event journal, command ledger, authentication model, saved-environment runtime, projection pipeline, secret store, and provider adapters all contain serious durability and security work. This is not a prototype that needs to be discarded.

It is not yet a release application, however. The blockers are concentrated at the product boundary rather than the core architecture:

1. There is no signed, notarized, multi-OS release pipeline or native release test matrix.
2. Packaged updates are unconditionally disabled.
3. Electron's privileged IPC trust is broader than its navigation trust, so a navigated loopback page could reach desktop capabilities.
4. Analytics is enabled by default, identifies users from provider credential files, and has no matching product privacy control or release privacy documentation.
5. The HTTPS sibling proxy trusts headers an external client can supply, undermining secure-cookie and cleartext-bootstrap decisions.
6. The Windows managed-provider installer can report success and persist `runtimeSource: "bundled"` after Codex or Claude installation failed.
7. Codex and Claude have no supported-version window, and external OpenCode servers bypass the local minimum-version check.
8. CI exercises only Ubuntu; browser suites, native installers, updates, macOS, Windows, and real Claude/OpenCode compatibility are not release gates.

A controlled internal alpha for trusted users remains reasonable if it is clearly labeled, network exposure is avoided, and analytics behavior is disclosed. A public stable release should wait until the Phase 0 and Phase 1 work below is complete.

## Scope and Coverage

The repository contained 1,233 tracked paths: 1,187 text files and 46 binary assets, totaling about 51.8 MB. The audit classified every tracked file, parsed all 31 tracked JSON files, checked Git modes and binary signatures, reviewed every source/configuration/test bucket, and traced the release, desktop, server, provider, renderer, shared-contract, script, documentation, and asset paths end to end.

Coverage by primary subtree:

| Area                                     | Tracked files | Coverage approach                                                                     |
| ---------------------------------------- | ------------: | ------------------------------------------------------------------------------------- |
| `apps/server`                            |           499 | Direct architecture/security/provider review plus semantic searches and tests         |
| `apps/web`                               |           428 | Direct UI/runtime review, browser-suite inventory, capability-boundary review         |
| `apps/desktop`                           |            96 | Direct Electron/IPC/lifecycle/update/platform review                                  |
| `packages/contracts`                     |            36 | Schema and compatibility-boundary review                                              |
| `packages/shared`                        |            49 | Utility, process, path, protocol, and portability review                              |
| `packages/effect-codex-app-server`       |            17 | Generator, generated protocol metadata, client, and pinning review                    |
| `packages/client-runtime`                |            10 | Scoped identity and client runtime review                                             |
| Scripts/workflows/root/docs/assets/other |            98 | Release automation, manifests, assets, fixtures, metadata, and stale-reference review |

Generated protocol and data files were reviewed through their generator, metadata, source pin, shape/integrity checks, import consumers, and tests rather than treating every generated line as independent handwritten logic. Binary assets were checked for type, duplication/use, metadata, and packaging role. Dependency caches and untracked/generated `dist`, `node_modules`, `.turbo`, and test screenshots were outside source scope.

This was performed on Linux. macOS and Windows conclusions based on source and packaging configuration are findings, not substitutes for final native certification.

## Release Blockers

### RB-01 — No production release pipeline, signing enforcement, or native OS matrix

**Evidence:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) has one Ubuntu 24.04 job. It runs source checks and `build:desktop`, but does not produce or publish installers. There is no release workflow. [`scripts/build-desktop-artifact.ts`](../scripts/build-desktop-artifact.ts) creates targets, but macOS configuration has no hardened runtime, entitlements, notarization, or fail-closed signing requirement. Windows explicitly permits unsigned artifacts unless a signed flag is selected. The script invokes Electron Builder with `--publish never`.

**Impact:** A maintainer can build artifacts manually, but the repository cannot reproducibly certify or publish a trusted release. macOS Gatekeeper and Windows reputation/signing behavior will be unsuitable for a stable consumer application. Cross-platform breakage can merge undetected.

**Required work:** Add a tag/manual release workflow with pinned macOS, Windows, and Linux runners; frozen dependency installation; native unit/build/package/smoke tests; artifact checksums and provenance; fail-closed Apple signing/notarization; Windows signing; GitHub release/update metadata publishing; and a documented rollback process. Keep PR CI cheaper if desired, but require the native matrix before a release tag is promoted.

### RB-02 — Packaged auto-update is deliberately unreachable

**Evidence:** [`apps/desktop/src/updates/DesktopUpdates.ts:48`](../apps/desktop/src/updates/DesktopUpdates.ts#L48) returns `true` unconditionally from `areDesktopUpdatesDisabledInThisBuild()`. The rest of the updater state machine and generated publish configuration therefore cannot update a normal packaged build.

**Impact:** Security fixes and provider compatibility updates cannot be delivered through the application. Existing updater UI and code appear more complete than the behavior users receive, which is a half-baked product surface.

**Required work:** Decide the stable/nightly update-channel contract, remove the hard disable only after signed update publishing exists, test fresh install/update/downgrade/recovery on macOS and Windows, define Linux distribution behavior, and ensure update metadata is signed/trusted and channel-isolated.

### RB-03 — Electron navigation and privileged IPC do not share an exact origin boundary

**Evidence:** [`apps/desktop/src/window/DesktopWindow.ts:169`](../apps/desktop/src/window/DesktopWindow.ts#L169) correctly enables sandboxing and context isolation and disables Node integration. It denies new windows, but installs no `will-navigate` or redirect guard before trusting the complete `webContents`. [`apps/desktop/src/ipc/DesktopIpc.ts:81`](../apps/desktop/src/ipc/DesktopIpc.ts#L81) accepts any `file:` URL and any HTTP(S) URL on any loopback host/port. The preload exposes consequential filesystem, shell, server-exposure, saved-secret, and update operations.

**Impact:** If the main window is navigated or redirected to attacker-controlled content on another loopback port, that page remains inside the trusted `webContents` and satisfies the broad sender URL check. A local web service or compromised renderer path could reach native desktop capabilities.

**Required work:** Pin navigation, redirects, and IPC sender validation to the exact bootstrapped origin (scheme, normalized host, and port) or an authenticated privileged app scheme. Reject all other navigations before commit, validate the top frame and exact origin per IPC request, minimize preload methods, and add adversarial tests for loopback ports, `file:` paths, redirects, subframes, destroyed senders, and replaced documents.

### RB-04 — Default-on analytics lacks release-grade consent and derives identity from provider credentials

**Evidence:** [`apps/server/src/telemetry/Layers/AnalyticsService.ts:29`](../apps/server/src/telemetry/Layers/AnalyticsService.ts#L29) embeds a production PostHog key/host and enables telemetry by default. It sends platform, architecture, client type, version, event properties, and a stable distinct ID. [`apps/server/src/telemetry/Identify.ts:35`](../apps/server/src/telemetry/Identify.ts#L35) derives that ID first from the Codex `account_id`, then Claude `userID`, before falling back to an anonymous file. [`apps/web/src/components/settings/UsageStatsPanel.tsx:195`](../apps/web/src/components/settings/UsageStatsPanel.tsx#L195) says “Data never leaves this machine,” but that switch governs local usage counters, not PostHog. There is no `PRIVACY.md` or in-product analytics control, and the payload still contains a stale `t3CodeVersion` property.

**Impact:** Users can reasonably misunderstand what leaves their machine. Reading provider identity files for unrelated product analytics expands the trust boundary around authentication material. This is a privacy, product-trust, and potentially regulatory blocker.

**Required work:** Make a conscious policy decision, document it, and implement a separate, visible analytics control. Prefer opt-in for a security-conscious coding tool. Generate a Cafe-owned random identifier rather than reading provider identity files; enumerate events/properties and retention; honor the setting before identity access or buffering; add deletion/reset support where applicable; remove stale T3 naming; and ship privacy documentation.

### RB-05 — HTTPS proxy provenance is spoofable by ordinary external HTTP clients

**Evidence:** [`apps/server/src/http.ts:219`](../apps/server/src/http.ts#L219) treats either `x-cafe-code-https-proxy: 1` or `x-forwarded-proto: https` as proof that a request came through the HTTPS sibling. [`apps/server/src/auth/http.ts:73`](../apps/server/src/auth/http.ts#L73) uses both headers to decide whether browser session cookies receive `Secure`. The HTTP listener is the same network-accessible backend the sibling proxies to; no private listener or capability authenticates the proxy hop.

**Impact:** An external cleartext HTTP client can spoof provenance, bypass the HTTPS bootstrap page, and influence cookie/security behavior. TLS still protects clients that actually use the HTTPS port, but server decisions are being made from untrusted headers.

**Required work:** Put the proxy-to-backend hop on a loopback/private listener or attach a high-entropy in-memory capability unavailable to external callers. Strip inbound forwarded/provenance headers, stamp trusted values only in the sibling proxy, require the authenticated provenance for every HTTPS-dependent decision, and test direct external HTTP spoof attempts.

### RB-06 — Windows managed-provider bootstrap is non-reproducible and suppresses failure

**Evidence:** [`apps/desktop/resources/installer.nsh:10`](../apps/desktop/resources/installer.nsh#L10) defaults the managed runtime checkbox on. [`apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1:104`](../apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1#L104) seeds bundled provider settings before provider installation. Provider installs use `@latest` at line 159, install directly into `current`, and only record npm exit status. The script catches errors and finishes with `exit 0` at line 264; NSIS logs the result but does not abort. Updates skip this entire bootstrap through `${isUpdated}`.

**Impact:** A network, npm, disk, or package regression can leave settings claiming bundled Codex/Claude are selected while no working shim exists. Builds are not reproducible because provider versions change independently of the application. Existing installations never receive the managed-provider refresh path.

**Required work:** Pin exact provider versions and integrity metadata in source; stage into versioned temporary directories; validate binaries and versions; atomically switch `current`; seed settings only after success; return nonzero and provide a recoverable installer choice on failure; define update/repair/uninstall ownership; and test clean, offline, partial, upgrade, rollback, non-ASCII-profile, locked-file, ARM64, and no-admin cases on Windows.

### RB-07 — Provider compatibility is probed, but not bounded to supported protocol versions

**Evidence:** Codex version output is parsed in [`apps/server/src/provider/Layers/CodexProvider.ts:1347`](../apps/server/src/provider/Layers/CodexProvider.ts#L1347), but there is no minimum/maximum supported CLI gate tied to the generated app-server schema. The generated protocol is pinned to a specific upstream revision while Cafe enables experimental API behavior. Claude similarly probes version and applies feature-specific model gates without a base supported-version window. [`apps/server/src/provider/Layers/OpenCodeProvider.ts:33`](../apps/server/src/provider/Layers/OpenCodeProvider.ts#L33) enforces a local minimum, but an externally configured server takes the path where `version` remains null.

**Impact:** Provider CLIs and app-server protocols evolve independently. An old or newly incompatible binary can pass availability checks and fail mid-turn, during approval, resume, streaming, or recovery. The Windows `@latest` installer magnifies this risk.

**Required work:** Publish and enforce a compatibility matrix per Cafe release. Pin bundled versions; define tested minimum and maximum or exact compatible ranges; fail health checks with actionable messages; validate external OpenCode server version/capabilities; regenerate Codex types in CI and review diffs; and add contract fixtures and opt-in live E2E coverage for every supported provider/version/platform combination.

### RB-08 — The test/release gates do not cover the supported product surface

**Evidence:** The root test task at audit time did not run [`apps/web/package.json`](../apps/web/package.json)'s `test:browser` suites. CI ran only Ubuntu. The repository had 13 browser suites, but they were not a CI step. Release smoke was not in CI. The default tests intentionally excluded live provider E2E; the opt-in coverage included real Codex and supervisor work but no equivalent Claude/OpenCode matrix. Native installers, update flows, signing, first-run bootstrap, OS credential storage, and desktop UI startup were not certified on macOS/Windows/Linux.

**Impact:** The exact surfaces most likely to break at release—Electron, browser interactions, installers, updates, provider binaries, and OS process behavior—can regress while required CI remains green.

**Required work:** Add layered gates: fast portable PR tests; browser tests on Chromium; native desktop build/smoke on all supported OSes; installer/update E2E on release candidates; and credential-backed provider canaries in a protected environment. Treat external-provider tests as explicit E2E, consistent with repository policy.

## High-Priority Findings

### H-01 — Web Push secrets are not private and subscriptions outlive their authenticated owner

[`apps/server/src/notifications/WebPushNotifications.ts:52`](../apps/server/src/notifications/WebPushNotifications.ts#L52) stores the VAPID private key and subscription `auth`/`p256dh` keys in `stateDir/web-push.json`. Persistence uses the generic atomic writer at line 169, which does not set `0600`; unlike `ServerSecretStore`, it does not create a private directory or normalize permissions. Stored subscriptions contain no session/user ownership. `notifyTurnCompleted` at line 264 sends every completed thread title/path to every subscription, and session revocation does not remove subscriptions.

Move VAPID private material and subscription keys to the private secret store or a `0600` private database/file. Bind each subscription to an authenticated session/client, remove it on session revocation, authorize notification scope, and test migration and permission repair. Provider environment secrets and OpenCode passwords were specifically re-checked and already use `ServerSecretStore`; this finding is limited to Web Push.

### H-02 — Windows stale-backend recovery contradicts the documented lifecycle guarantee

[`apps/desktop/src/backend/DesktopProcessReaper.ts:202`](../apps/desktop/src/backend/DesktopProcessReaper.ts#L202) returns an empty result on Windows. This is the reaper used by backend replacement startup, even though the architecture requires stale backend children to be terminated before a replacement binds.

A wedged Windows backend can retain the port, database, or files while Electron repeatedly starts replacements. Implement Windows discovery with the same direct `powershell.exe`/CIM discipline already used by `killall`, protect the current ancestry, terminate children before parents, and add native recovery tests.

### H-03 — Browser responses lack a production security-header policy and depend on runtime third parties

Static responses set cache/Vary headers but no Content Security Policy, frame protection, referrer policy, or permissions policy. [`apps/web/index.html:93`](../apps/web/index.html#L93) loads Google Fonts and [`apps/web/src/vscode-icons.ts:5`](../apps/web/src/vscode-icons.ts#L5) builds jsDelivr URLs at runtime.

Self-host fonts and required icons, then add a restrictive CSP compatible with Vite output and KaTeX (`trust: false` is already good). Add `frame-ancestors`, `object-src`, `base-uri`, `form-action`, referrer, nosniff, and permissions policies. Test desktop, browser, self-signed HTTPS, and reverse-proxy deployment.

### H-04 — Several HTTP bodies are unbounded before parsing or validation

Web Push JSON, client debug JSON, and OTLP JSON call `request.json` without an explicit limit. The branding upload checks `Content-Length`, but a chunked request can still be fully buffered by `request.arrayBuffer` before the decoded image-size validation. [`apps/server/src/http.ts:448`](../apps/server/src/http.ts#L448)'s debug route is unauthenticated when debug logging is enabled and logs attacker-supplied structured data. OTLP decode failure logs the complete body at lines 581–585, which can include prompt or UI data.

Add route-specific streaming/aggregate limits independent of `Content-Length`; authenticate debug logging; validate schemas before logging; redact or summarize OTLP failures; rate-limit diagnostic routes; and include oversized/chunked/malformed tests.

### H-05 — Desktop debug mode exposes full local state without a capability token

[`apps/desktop/src/debug/DesktopDebugServer.ts:15`](../apps/desktop/src/debug/DesktopDebugServer.ts#L15) enables a loopback HTTP server for either `--cafe-debug` or the generic `--debug`. [`handleRequest`](../apps/desktop/src/debug/DesktopDebugServer.ts#L1212) performs no authentication. `?detail=full` returns raw process paths/diagnostics plus complete renderer and daemon snapshots, which can include message/activity previews and operational identifiers.

Use a dedicated Cafe-only switch, issue a high-entropy per-run capability, require it without placing it in logs/argv, default to compact redacted output, and make full forensic data an explicit local export with a warning. Add tests that another local process cannot read it without authorization.

### H-06 — Authenticated attachments are marked public and immutable for one year

[`apps/server/src/http.ts:613`](../apps/server/src/http.ts#L613) authenticates attachment requests, but line 659 responds with `Cache-Control: public, max-age=31536000, immutable`.

Shared/browser/intermediary caches can retain sensitive prompt attachments after logout or revocation. Use `private, no-store` by default, or a carefully designed private revalidation strategy. Confirm service-worker and reverse-proxy behavior.

### H-07 — TLS certificate reuse does not verify current subject alternative names

Certificate freshness checks key/certificate validity but do not compare the current advertised host/IP set with SANs in the stored certificate. A DHCP, VPN, hostname, or interface change can leave the app serving a certificate invalid for its advertised address until expiry.

Parse and compare SANs on startup, regenerate when required names change, preserve private-key permissions, and test address churn. Consider a user-facing certificate reset/diagnostic action.

### H-08 — Remote environment paths can reach local desktop shell capabilities

[`apps/web/src/localCapabilities.ts:8`](../apps/web/src/localCapabilities.ts#L8) reports local shell capabilities based only on the desktop bridge. `ChatHeader` correctly also checks that the active environment is primary, but [`ChatMarkdown.tsx:535`](../apps/web/src/components/ChatMarkdown.tsx#L535), [`components/chat/MessagesTimeline.tsx:1865`](../apps/web/src/components/chat/MessagesTimeline.tsx#L1865), and [`DiffPanel.tsx:424`](../apps/web/src/components/DiffPanel.tsx#L424) open/reveal remote paths through the local machine without the same environment check. The additional-directory dialog in [`Sidebar.tsx:2100`](../apps/web/src/components/Sidebar.tsx#L2100) can select a local folder while editing a remote project, and its Browse button becomes a silent no-op in a pure browser.

Make capability resolution environment-aware and centralize it. Only the primary desktop environment may open local editors, reveal paths, launch terminals, or pick local folders. Remote/browser contexts should offer copy-path/manual-entry alternatives and explain why. Add desktop-with-remote-environment browser tests for every shell action.

### H-09 — Production artifacts expose source and carry avoidable bundle weight

Desktop and server `tsdown` configurations always generate source maps; the web build defaults to source maps unless explicitly disabled. Current generated output contained roughly 66.8 MB of maps across server, web, and desktop, with maps accounting for more than half of server/web staged bytes. The web bundle also ships broad Shiki language/theme assets and a large main chunk.

Default public release builds to no source maps or upload hidden maps to an access-controlled error service without packaging them. Add artifact allowlists/size budgets, source/map leakage checks, chunk analysis, and lazy-loading for heavy syntax/diff/settings features.

### H-10 — Electron hardening stops at BrowserWindow flags

The secure `webPreferences` are a good baseline, but the release build does not configure Electron fuses, explicit permission request/check handlers, or macOS hardened-runtime entitlements. The privileged `cafecode:` scheme is registered even though the main window uses backend HTTP and no production consumer was found.

Disable unused Electron features through fuses, deny unexpected permissions, validate every IPC sender, either remove the custom scheme or make it the narrow authenticated app origin, and add packaged-build hardening assertions.

### H-11 — Provider supervisor is a large quarantined subsystem, not a supported lifecycle

The repository exports supervisor contracts, migrations, a process manager, registry, daemon bridge, diagnostics, CLI role, and tests, while the documented architecture says automatic daemon handoff is disabled until registry and active-session truth survive restart/fallback correctly.

This is substantial dormant complexity in the most sensitive lifecycle area. For release, either finish the recovery invariants and certify it, or remove it from production entry points, settings, diagnostics, exported contracts, and default builds while retaining an isolated development branch/design. Do not present it as a reliability layer until handoff/restart behavior is proven.

### H-12 — Release smoke does not prove the desktop became usable

The smoke path primarily builds/stages the release and checks process output for a small fatal-string set. The desktop smoke waits briefly and terminates the child; it does not assert backend readiness, window creation, renderer bootstrap, provider health, or a meaningful UI interaction.

Create a packaged smoke protocol that reports authenticated readiness without exposing secrets, then assert window/renderer/backend state. Run it on each native artifact and include first launch, second launch/adoption, graceful quit, crash recovery, and uninstall/upgrade cases.

## Medium-Priority Findings

### M-01 — Pairing credentials are generated in URL query strings

[`apps/server/src/authPairingUrl.ts:3`](../apps/server/src/authPairingUrl.ts#L3) deliberately emits `/pair?token=...` because query values survive terminal/OS/dev redirect behavior. The renderer already prefers fragment tokens and strips either shape. Query credentials can enter browser history, proxy/access logs, screenshots, copied logs, and referrer paths before client cleanup.

Use fragments for normal release links and explicitly solve the opener/dev redirect cases that previously split them. If query compatibility remains, exchange it on a minimal no-third-party page, set strict referrer/no-store policy, and never log the raw URL.

### M-02 — Claude diagnostic traces include more launch context than necessary

[`apps/server/src/provider/Layers/ClaudeAdapter.ts:4480`](../apps/server/src/provider/Layers/ClaudeAdapter.ts#L4480) records executable path, cwd, resume/session identifiers, session file, settings JSON, and arbitrary launch arguments in trace attributes. Those traces can be exported via OTLP.

Allowlist safe attributes and hash or omit paths/identifiers. Never emit arbitrary argument values or settings JSON. Add secret-shaped regression fixtures.

### M-03 — External OpenCode servers bypass version/capability validation

The local OpenCode path enforces `1.14.19`; [`apps/server/src/provider/opencodeRuntime.ts:472`](../apps/server/src/provider/opencodeRuntime.ts#L472) accepts an external URL as an unowned server, and provider health reports no version gate for it.

Call a server version/capability endpoint before marking it ready and reject incompatible protocol shapes. Keep password redaction and secret-store behavior, which are already implemented correctly.

### M-04 — The production web root includes the MSW test worker

[`apps/web/public/mockServiceWorker.js`](../apps/web/public/mockServiceWorker.js) is required by browser suites, but Vite copies `public` into production output. Production code does not register it.

Move the worker to test-only static serving or explicitly exclude it from release builds. Add an artifact assertion that test fixtures/workers are absent.

### M-05 — Root UI errors expose raw stacks and local paths

[`apps/web/src/routes/__root.tsx:213`](../apps/web/src/routes/__root.tsx#L213) renders an expandable details block; `errorDetails` returns `error.stack` when available. In remote browser use, this can disclose server/build paths and implementation details to an authenticated client that only needs a recoverable message.

Show a sanitized error code/summary by default and put full diagnostics behind a deliberate local export or debug mode.

### M-06 — `NodeSqliteClient.executeStream` is a latent crash, not an implementation

[`apps/server/src/persistence/NodeSqliteClient.ts:208`](../apps/server/src/persistence/NodeSqliteClient.ts#L208) returns `Stream.die("executeStream not implemented")`. No current call site was found.

Implement it consistently with the SQL client contract or make the unsupported method impossible at the type/service boundary. Add a contract test before a future caller turns it into a runtime defect.

### M-07 — Scoped client keys use an ambiguous delimiter with unconstrained IDs

[`packages/client-runtime/src/scoped.ts:20`](../packages/client-runtime/src/scoped.ts#L20) creates `environmentId:localId` and parses at the first colon. The branded entity schemas only require a trimmed non-empty string, and a persisted environment ID is accepted as such.

Current generated IDs are normally UUID-like, so this is latent rather than active. Encode components unambiguously (length prefix, JSON tuple, or escaping) or constrain all participating IDs and migrate stored keys.

### M-08 — Dead/orphan surfaces and dependencies should be removed or justified

`packages/tailscale` contains only a `tsconfig.json` and has no imports. `node-pty` and server-side `electron-updater` are declared runtime dependencies with no source imports found. The scripts package declares Anthropic packages without source imports. The custom `cafecode:` protocol has no production navigation consumer. These increase native build, supply-chain, and maintenance surface.

Run a package-aware dependency analysis, remove confirmed dead dependencies/packages/protocols, and document any intentionally indirect runtime dependency. In particular, `node-pty` is a native dependency and deserves removal if terminal support no longer uses it.

### M-09 — Release identity and documentation still describe an alpha/source checkout

[`apps/desktop/package.json`](../apps/desktop/package.json) and [`apps/web/index.html:99`](../apps/web/index.html#L99) display “Cafe Code (Alpha).” The root/server READMEs describe pre-release/source-install behavior and do not provide supported-platform installer, update, backup, privacy, security-reporting, troubleshooting, or lifecycle commitments. There is no changelog, security policy, or privacy document.

Define release channels and support promises before removing Alpha. Add installation/update/uninstall/data-location/backup/recovery docs, `SECURITY.md`, privacy documentation, a changelog/release-note process, provider/version support, and known limitations.

### M-10 — Linux artifact coverage is narrower than the stated architecture support

The root Linux distribution command builds only x64 AppImage, although the artifact script accepts architectures and Windows/macOS expose explicit ARM64 commands. An Arch package path also exists, but it is not in a release workflow.

Decide the actual supported architecture/package matrix and automate it. If Linux ARM64 or non-AppImage formats are not supported, say so explicitly.

### M-11 — Large UI/provider modules are regression multipliers

`ChatView.tsx` is about 6,500 lines, `ChatViewBrowser.shared.tsx` is similarly large, and `CodexSessionRuntime.ts`/`ClaudeAdapter.ts` are multi-thousand-line protocol/lifecycle modules. They mix state-machine, rendering/protocol, diagnostics, and compatibility concerns.

Do not block a first beta solely on file length, but extract cohesive state machines and protocol translators before adding more providers/features. Preserve event/schema tests during extraction and set review-size/module-responsibility guidance.

### M-12 — Third-party release compliance is manual and incomplete

`LICENSE` and an upstream `NOTICE.md` exist, but no generated third-party license/notice bundle or release-time dependency attribution check was found.

Add automated dependency-license inventory and include required notices in installers/about UI or distribution documentation. Have counsel/release ownership review the result; this audit is not a legal opinion.

### M-13 — Root cleanup and release helpers are not natively portable

The root clean script uses `rm -rf`, and release smoke/helpers assume shell behavior more natural on POSIX. They may work under Git Bash or CI shims but are not a reliable native Windows maintainer workflow.

Use cross-platform Node filesystem APIs for repository scripts and execute them on the Windows CI runner.

### M-14 — Dependency hygiene needs a release cadence

At audit time, the then-current production dependency audit reported one low-severity transitive `@babel/core` arbitrary-file-read advisory. Several core dependencies had newer releases, including Electron, Electron Updater, Claude Agent SDK, OpenCode SDK, and Effect beta versions.

Do not blindly upgrade immediately before release. Establish automated update PRs, vulnerability gates, a tested provider/toolchain compatibility cadence, and a release freeze process. Security-support timelines matter more than being on the newest version every day.

## Low-Priority and Cleanup Findings

1. [`apps/server/src/auth/utils.ts`](../apps/server/src/auth/utils.ts) still names session cookies `t3_session`; telemetry also contains `t3CodeVersion`. Rename with a migration/dual-read window so old sessions fail predictably rather than mysteriously.
2. Legacy `.t3code` VCS lookup is intentionally retained as a compatibility fallback; document its removal horizon instead of deleting it abruptly.
3. Cursor remains in editor-oriented schemas and legacy persisted-provider decoding. Runtime registries correctly filter it as a retired provider; keep tests so cleanup does not break old data.
4. [`apps/web/src/components/chat/OpenInPicker.tsx`](../apps/web/src/components/chat/OpenInPicker.tsx) uses the unrelated group label “Subscription actions,” an accessibility copy defect.
5. Package descriptions such as “minimal” no longer match the size/responsibility of their packages.
6. `apps/web/public/cafe-code-sidebar-icon.png` appears redundant with imported source branding assets; verify packaged consumers, then remove duplicates.
7. Release helper logic contains small duplication such as repeated publish-preparation assertions; consolidate when the release workflow is built.
8. The provider log/diagnostic code generally redacts commands well, but release security tests should keep secret-shaped argv, URL credential, cookie, auth-path, and environment fixtures across all diagnostic surfaces.

## Provider Integration Assessment

| Provider/runtime    | What is solid                                                                                                                                                                                   | What blocks release confidence                                                                                                                                              | Required certification                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex               | Generated typed app-server protocol; explicit init/stream/approval/resume/interrupt paths; shadow-home auth is copied privately rather than symlinked; daemon persistence/replay is substantial | No supported CLI window; experimental/version-specific protocol surface; bundled installer uses latest; only limited opt-in real-binary coverage                            | Pin/test supported CLI versions on all OSes; schema-diff CI; long-turn, approval, steer, reconnect, auth refresh, daemon restart, and downgrade fixtures |
| Claude              | Agent SDK adapter covers streaming, tools, permissions, session resume, attachments, usage, and Windows managed runtime; version is probed                                                      | No base supported SDK/CLI range; full-access mode intentionally bypasses permissions and needs unmistakable UX; trace attributes can leak context; no protected live matrix | Pin compatible SDK/CLI; certify permission modes and interactive login per OS; redact traces; 16+ hour/restart/auth/approval/live E2E                    |
| OpenCode            | First-party SDK path; loopback-owned server lifecycle is scoped; explicit external-server ownership; password is stored/redacted correctly; local minimum version exists                        | External server skips version/capability gate; live compatibility coverage absent; SDK/server drift still possible                                                          | Validate external server version/capabilities; pin/test SDK/server pairs; owned-process cleanup, permission/question/abort/resume, auth, and crash E2E   |
| Provider daemon     | Authenticated loopback/IPC design, high-entropy capabilities, command ledger, event journal, replay, health/recovery, bounded logs, and explicit desktop recovery order                         | Native long-duration/restart certification is incomplete; debug/proxy/installer boundaries can undercut it                                                                  | Multi-OS soak and fault injection: desktop/backend/daemon crash permutations, disk pressure, replay compaction, port collision, and 16+ hour sessions    |
| Provider supervisor | Considerable process/registry/contract/migration groundwork                                                                                                                                     | Automatic handoff is explicitly disabled because restart/fallback truth is not reliable                                                                                     | Finish and prove invariants, or remove/quarantine it from the release product                                                                            |

The provider adapters are not “fake” or merely stubbed. The central release risk is compatibility and certification: they are complex integrations against fast-moving external binaries without an enforced tested-version contract.

## Supported-OS Readiness

| Platform       | Current path                                                                                                                 | Release gaps                                                                                                                                                       | Assessment                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| macOS          | DMG + ZIP targets, app icon/category, Electron runtime                                                                       | No fail-closed signing, hardened runtime/entitlements, notarization, update certification, or native CI; Intel/Apple Silicon artifacts not published automatically | No-go                                  |
| Windows        | NSIS x64/ARM64 targets, optional Azure signing path, managed local Node/provider runtime, Windows-specific process/path work | Installer suppresses provider failures and uses latest; stale-backend reap no-op; unsigned default; no native CI/update/repair/uninstall E2E                       | No-go                                  |
| Linux          | x64 AppImage root command plus Arch packaging path; loopback/web flow; POSIX process lifecycle                               | No release workflow; architecture/package promise unclear; no packaged UI readiness assertion; updates undefined; external runtime assets hurt offline behavior    | Beta only after native packaging tests |
| Browser/remote | Authenticated bearer/bootstrap/WS model, saved environment isolation, HTTPS sibling, responsive UI/browser suites            | Proxy provenance, subscription ownership, CSP/body limits, query tokens, runtime third parties, browser suites absent from CI, local-shell leakage                 | No-go for untrusted LAN exposure       |

## Half-Baked, Stale, and Redundant Surfaces

### Finish or remove before stable

- Packaged updater: substantial implementation, permanently disabled.
- Provider supervisor: substantial implementation, automatic reliability role deliberately disabled.
- SQLite streaming: service method exported, implemented as a defect.
- Windows managed provider runtime: visible/default-on installer feature without transactional success semantics.
- Custom `cafecode:` protocol: privileged registered surface without a production navigation role.
- Web Push: user-visible feature without credential ownership/revocation integration or private storage.

### Remove or formally justify

- Orphan `packages/tailscale` shell.
- Unused `node-pty` and server `electron-updater` declarations if package-aware analysis confirms them.
- Production `mockServiceWorker.js`.
- Runtime CDN icon/font dependencies and likely duplicate public branding assets.
- Stale T3 telemetry/cookie names and outdated package descriptions.

### Intentional compatibility references to retain for now

- Cursor persisted-provider decoding plus runtime filtering.
- Cursor/editor identifiers where Cursor remains a supported editor rather than a provider.
- Legacy `.t3code` VCS fallback.
- T3/upstream references in license/notice history and test fixtures.

Blanket search-and-replace would damage compatibility. Remove only the stale runtime/product names, with migration tests for persisted state.

## Positive Findings Worth Preserving

- Main authentication uses one-time pairing credentials, signed/revocable sessions, short-lived WebSocket tokens, role checks, and non-URL bearer sessions.
- Saved desktop environment bearer tokens use Electron `safeStorage`; browser persistence keeps bearer sessions out of local storage.
- Provider daemon/supervisor secrets and server provider passwords use private files and restrictive permissions.
- Codex shadow homes avoid auth symlinks and include Windows-safe junction/hard-link/copy behavior.
- Detached runtime stdio/log ownership and desktop daemon recovery ordering are explicitly designed for restart survival.
- Projection/replay paths recognize large diff and long-lived-session pressure rather than assuming short chats.
- Renderer environment routing, saved-environment identity checks, reconnect/backpressure logic, and primary-environment isolation have meaningful tests.
- KaTeX runs with `trust: false`, and Markdown math/citation/table behavior has unusually detailed regression coverage.
- External OpenCode processes are not claimed as Cafe-owned, and owned loopback servers are scope-cleaned.
- Process diagnostics generally avoid raw argv and contain redaction tests.

## Verification Results

The source review was completed before running these commands. Results are filled from the final reviewed worktree:

| Command                              | Result  | Notes                                                                                                                     |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Formatter check                      | Pass    | All 1,179 checked files passed after formatting this new report; no product source needed formatting                      |
| Lint                                 | Pass    | Zero errors; one existing React array-index-key warning in `ActivityHeatmap.tsx`                                          |
| Typecheck                            | Pass    | 9/9 workspace tasks; uncached; 6m52.791s                                                                                  |
| Root unit-test task                  | Pass    | 9/9 workspace tasks; server alone ran 163 files and 1,249 assertions; 3m54.393s                                           |
| Browser test task                    | Pass    | 13 files and 171 assertions; emitted one non-fatal `legend-list` zero-height warning; 138.63s                             |
| Desktop build task                   | Pass    | 3/3 tasks from cache; warned about a 3.53 MB renderer chunk, ineffective dynamic import, and production source-map output |
| Release smoke task                   | Pass    | Clean staged dependency install and existing artifact checks passed; this is not a signed/native installer launch test    |
| Native macOS/Windows installer smoke | Not run | Linux audit host; required in the release matrix                                                                          |
| Live provider credential E2E         | Not run | Explicit opt-in release canary; no credentials assumed                                                                    |

Passing source gates does not override the release blockers above; most are policy, security-boundary, packaging, native-runtime, and missing-test issues rather than TypeScript compilation errors.

## Remediation Roadmap

### Phase 0 — Make the current alpha safe to distribute narrowly

1. Fix exact Electron origin/navigation/IPC validation.
2. Disable analytics by default until consent, product control, and privacy documentation exist; stop reading provider identity files.
3. Authenticate HTTPS proxy provenance and strip untrusted forwarded headers.
4. Make Web Push private and session-owned, or disable it temporarily.
5. Fix Windows bootstrap to pin versions, fail honestly, and commit atomically; otherwise default it off.
6. Add body limits, debug-route authentication/redaction, private attachment caching, and baseline security headers.

### Phase 1 — Establish a real release train

1. Create native macOS/Windows/Linux CI and release workflows.
2. Enforce signing/notarization and artifact provenance/checksums.
3. Add browser suites and packaged desktop readiness smoke to CI.
4. Define channels, enable and certify signed updates, and document rollback.
5. Remove source maps/test assets from public artifacts and add size/content budgets.
6. Publish installation, update, uninstall, data, privacy, security, support, and known-limit documentation.

### Phase 2 — Certify provider behavior

1. Pin bundled Codex/Claude and supported OpenCode pairs.
2. Enforce version/capability gates, including external OpenCode.
3. Run protected live canaries for all providers on all OSes.
4. Add 16+ hour soak, restart/fault, approval, steer, resume, auth-refresh, and partial-stream cases.
5. Decide whether to complete or remove the provider supervisor.

### Phase 3 — Product hardening and maintainability

1. Centralize environment-aware local capabilities.
2. Add Electron fuses/permission policy and remove unused privileged surfaces.
3. Split the largest renderer/provider modules around explicit state machines.
4. Remove orphan dependencies/packages and stale names with migrations.
5. Automate dependency/security/license review and define supported architecture/package matrices.

## Stable-Release Exit Criteria

Cafe Code should not be called stable until all of the following are true:

- No open release blocker or unaccepted high-priority security/privacy finding.
- Signed/notarized artifacts are built reproducibly from a protected tag on native runners.
- Fresh install, launch, quit, restart, upgrade, rollback/recovery, and uninstall pass on supported macOS, Windows, and Linux targets.
- Electron navigation/IPC, HTTP/HTTPS proxying, authentication, Web Push, attachments, and diagnostics have adversarial tests.
- Analytics behavior is documented, user-controlled, and independent of provider credential identity.
- Every bundled/supported provider version is pinned or range-gated and passes protected live and long-duration tests.
- Browser tests, desktop build, package smoke, dependency audit, artifact-content checks, and source quality gates are required release checks.
- Updates are either fully signed/tested or the product clearly documents a deliberate external package-manager update model; unreachable updater UI/code is removed.
- Product docs define supported OS/architecture/provider versions, data locations, backup/recovery, privacy, security reporting, and known limitations.

## Reference Standards Consulted

- Electron security checklist: <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron code signing: <https://www.electronjs.org/docs/latest/tutorial/code-signing>
- Electron Builder macOS signing/notarization: <https://www.electron.build/docs/features/code-signing/code-signing-mac/> and <https://www.electron.build/docs/notarization/>
- OpenAI Codex app-server documentation and generated schema for the pinned upstream revision
- Anthropic Claude Code CLI reference: <https://docs.anthropic.com/en/docs/claude-code/cli-usage>
- OpenCode agent/permission documentation: <https://opencode.ai/docs/agents/>

## Final Decision

**Do not ship this repository as a public stable release yet.**

The shortest credible route is not a rewrite. First close the security/privacy and Windows installer blockers, then establish signed native release automation and provider version certification. Once those are in place, the existing core architecture is strong enough to support a serious beta and, after native soak/update evidence, a stable release.
