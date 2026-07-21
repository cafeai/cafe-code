# Cafe Code Categorized Release-Readiness Worklist

Created: 2026-07-15
Source audit: [Cafe Code release-readiness audit](./release-readiness-audit-2026-07-15.md)
Scope: all 42 audit findings, assigned once to a primary category

The categories describe the primary nature of each finding. Some items have secondary reliability, security, or release-engineering effects. “Nice to haves” means product/release maturity work rather than an active code defect; several are still mandatory before calling the application stable.

## Nice to haves

These are release-maturity, certification, documentation, and compliance improvements rather than directly exploitable weaknesses or current code failures.

- [ ] **RB-08 — Expand release gates to the supported product surface.**
  - Add browser tests to required CI.
  - Run native desktop package/launch smoke on macOS, Windows, and Linux.
  - Add installer, first-run, update, credential-store, recovery, uninstall, and protected live-provider E2E.
  - **Complete when:** every claimed platform and provider has a required release-candidate gate.

- [ ] **H-12 — Make release smoke prove that the packaged product is usable.**
  - Assert backend readiness, window creation, renderer bootstrap, provider health, and a meaningful UI interaction.
  - Cover first launch, second-launch adoption, graceful quit, crash recovery, updates, and uninstall.
  - **Complete when:** each native artifact demonstrates authenticated, secret-safe application readiness rather than merely staying alive briefly.

- [ ] **M-09 — Replace alpha/source-checkout documentation with release documentation.**
  - Define release channels and support commitments.
  - Document installation, updates, uninstall, data locations, backup/recovery, troubleshooting, privacy, security reporting, provider versions, and known limitations.
  - Add `SECURITY.md`, privacy documentation, and a changelog/release-note process.
  - **Complete when:** a new user can install, operate, recover, update, and report a problem without source-checkout knowledge.

- [ ] **M-10 — Define Linux architecture and package support.**
  - Decide whether Linux ARM64, Arch, and non-AppImage formats are supported.
  - Automate every supported target and clearly document unsupported targets.
  - **Complete when:** release automation and documentation state the same Linux architecture/package matrix.

- [ ] **M-12 — Automate third-party license compliance.**
  - Generate dependency license and notice inventories during releases.
  - Include required attributions in distributions or product documentation.
  - Obtain appropriate release/legal review.
  - **Complete when:** every distributed dependency has a reviewed, reproducible attribution record.

## Security issues

Each item includes the concrete attack or data-exposure vector. Where no malicious actor is required, the vector is identified as an unsafe product data flow rather than overstated as an exploit.

- [ ] **RB-01 — No trusted production release pipeline, signing enforcement, or native OS matrix.**
  - **Attack vector:** an attacker who compromises a download location, mirror, release account, or build path can substitute a modified installer. Without fail-closed signing/notarization, users and the OS cannot reliably distinguish the substituted artifact from the publisher’s build.
  - Add protected-tag workflows on pinned macOS, Windows, and Linux runners; frozen installs; enforced Apple/Windows signing; notarization; checksums; provenance; native smoke; and rollback procedures.
  - **Complete when:** public artifacts are reproducibly built, signed, verified, and promoted only after native release gates pass.

- [ ] **RB-03 — Electron navigation and privileged IPC do not share an exact origin boundary.**
  - **Attack vector:** malicious content served from another loopback port, or reached through a renderer redirect/navigation, still satisfies the broad loopback/file sender check and can invoke privileged preload operations for files, shell actions, settings, secrets, or updates.
  - Pin navigation, redirects, top-frame validation, and IPC authorization to the exact bootstrapped origin; minimize preload capabilities; test alternate ports, `file:` paths, redirects, subframes, and replaced documents.
  - **Complete when:** no document outside the exact trusted origin can invoke any privileged IPC method.

- [ ] **RB-04 — Default-on analytics lacks informed consent and derives identity from provider credentials.**
  - **Exposure vector:** no external attacker is required. The product reads Codex/Claude account identifiers and sends a stable correlated identifier plus product metadata to PostHog without a matching visible control; misleading local-usage copy can prevent informed consent.
  - Prefer opt-in; add a dedicated control; generate a Cafe-owned random identifier; stop provider-identity reads; document events, retention, reset/deletion, and destinations; remove stale T3 naming.
  - **Complete when:** analytics is user-controlled, documented, and independent of provider authentication identities.

- [ ] **RB-05 — HTTPS proxy provenance is spoofable.**
  - **Attack vector:** a remote client connecting directly to the cleartext backend can supply `x-cafe-code-https-proxy: 1` or `x-forwarded-proto: https`, impersonating the TLS sibling and influencing HTTPS bootstrap and `Secure` cookie decisions.
  - Use a private hop or high-entropy proxy capability; strip inbound provenance headers; stamp trusted values only at the proxy; add direct spoof tests.
  - **Complete when:** externally supplied headers can never establish trusted TLS provenance.

- [ ] **RB-06 — Windows managed-provider bootstrap uses mutable packages and suppresses failure.**
  - **Attack vector:** compromise of the npm account/registry path, dependency supply chain, or mutable `@latest` resolution can place attacker-controlled provider code into a trusted Cafe-managed runtime. Suppressed failures can also leave users on an unexpected or partially installed binary.
  - Pin versions and integrity; stage into versioned temporary directories; validate before an atomic switch; persist settings only after success; propagate failures; define update/repair/rollback/uninstall behavior.
  - **Complete when:** the installed provider bytes are pinned, verified, transactional, and failures cannot report success.

- [ ] **H-01 — Web Push secrets are not private and subscriptions outlive their authenticated owner.**
  - **Attack vector:** another local user or local malware can read permissively stored VAPID/subscription authentication material. A stale or transferred subscription endpoint can continue receiving thread titles and paths after its Cafe session is revoked.
  - Move keys to private `0600` storage; bind subscriptions to sessions/clients and notification scope; remove them on revocation; test migration and permission repair.
  - **Complete when:** only the owning authenticated client can retain and receive its authorized notifications.

- [ ] **H-03 — Browser responses lack security headers and load runtime third parties.**
  - **Attack vector:** an injected script, compromised CDN asset, malicious intermediary on an unprotected connection, or framing site has fewer browser restrictions because CSP, frame protection, referrer policy, and permissions policy are absent. Runtime Google/jsDelivr dependencies add a supply-chain and tracking surface.
  - Self-host assets; add restrictive CSP, `frame-ancestors`, `object-src`, `base-uri`, `form-action`, referrer, nosniff, and permissions policies; test all deployment modes.
  - **Complete when:** unexpected scripts, framing, object embedding, referrer leakage, and browser permissions are denied by policy.

- [ ] **H-04 — HTTP request bodies are unbounded and unsafe failures can log raw bodies.**
  - **Attack vector:** a remote client can send oversized, chunked, malformed, or slow bodies to consume memory/CPU and degrade or crash the server. Crafted debug/OTLP bodies can also place prompt-like secrets or attacker-controlled data in logs.
  - Add streaming/aggregate limits independent of `Content-Length`; authenticate and rate-limit debug ingestion; validate schemas; redact OTLP failures; test oversized/chunked/malformed requests.
  - **Complete when:** every body-bearing route has enforced limits and safe failure logging.

- [ ] **H-05 — Desktop debug mode exposes full local state without authentication.**
  - **Attack vector:** any process running as the local user can discover/query the loopback debug port and retrieve process paths, daemon/renderer snapshots, operational identifiers, and message/activity previews without a capability token.
  - Require a Cafe-specific switch and high-entropy per-run capability; avoid argv/log exposure; default to compact redacted output; make forensic export explicit.
  - **Complete when:** unrelated local processes cannot read diagnostics.

- [ ] **H-06 — Authenticated attachments are publicly cacheable for one year.**
  - **Attack vector:** a shared browser profile, proxy, gateway, service worker, or intermediary cache can retain an authenticated prompt attachment and serve it after logout, revocation, or a change of user.
  - Use `private, no-store` by default or a justified private revalidation design; test browser, proxy, and service-worker caches.
  - **Complete when:** attachment access cannot outlive its authorization through caching.

- [ ] **H-07 — TLS certificate reuse ignores changed subject alternative names.**
  - **Attack vector:** after hostname, DHCP, VPN, or interface changes, clients receive a certificate that does not cover the advertised address. Users may work around repeated certificate warnings, creating an opportunity for a network attacker to perform a man-in-the-middle attack once warning discipline is lost.
  - Compare SANs at startup; regenerate when names change; preserve private-key permissions; add address-churn tests and a reset/diagnostic action.
  - **Complete when:** every advertised HTTPS name is covered by the active certificate without asking users to bypass warnings.

- [ ] **H-08 — Remote environment paths can reach local desktop capabilities.**
  - **Attack vector:** a malicious or compromised remote Cafe server can return paths that the Electron renderer sends to local editor, reveal, diff, terminal, or folder-picker operations. The victim may then expose local filesystem structure or act on the wrong machine under remote content’s direction.
  - Centralize environment-aware capabilities; allow local shell actions only for the primary desktop environment; provide copy/manual alternatives; test every action with a remote environment active.
  - **Complete when:** remote-originated paths can never trigger local machine operations.

- [ ] **H-09 — Production artifacts expose source maps and excessive implementation detail.**
  - **Attack vector:** anyone who obtains the public artifact can use bundled source maps and internal paths to reconstruct source, identify private implementation details, and accelerate exploit research. The large-bundle aspect is primarily performance debt, not a direct exploit.
  - Exclude public source maps or upload hidden maps to controlled storage; add artifact allowlists/leakage checks and size budgets; split/lazy-load heavy renderer assets.
  - **Complete when:** public artifacts contain only intentional runtime material and meet the agreed size budget.

- [ ] **H-10 — Electron hardening stops at BrowserWindow flags.**
  - **Attack vector:** renderer injection or navigation compromise has a larger post-exploitation surface when unnecessary Electron features/fuses remain enabled, unexpected permission requests are not centrally denied, and an unused privileged custom scheme remains registered.
  - Configure fuses and permission handlers; assert packaged security settings; add hardened-runtime entitlements; remove or strictly constrain `cafecode:`.
  - **Complete when:** unused Electron capabilities are disabled and all permissions/origins fail closed.

- [ ] **M-01 — Pairing credentials are generated in URL query strings.**
  - **Attack vector:** a pairing token can leak through browser history, access/proxy logs, referrers, screenshots, clipboard contents, or copied terminal output; a recipient can redeem it before expiry.
  - Prefer URL fragments; fix opener/dev redirects; if query compatibility remains, use a minimal no-third-party/no-store exchange page and never log the URL.
  - **Complete when:** normal pairing credentials do not enter query-bearing history or logs.

- [ ] **M-02 — Claude traces include excessive launch context.**
  - **Attack vector:** sensitive paths, session identifiers, settings JSON, or secret-bearing launch arguments can be exported to an OTLP collector or read by anyone with trace access.
  - Allowlist safe fields; hash/omit paths and identifiers; never trace arbitrary arguments/settings; add secret-shaped fixtures.
  - **Complete when:** provider traces cannot disclose credentials, prompts, private paths, or session material.

- [ ] **M-03 — External OpenCode servers bypass version and capability validation.**
  - **Attack vector:** a compromised, malicious, or DNS-redirected external OpenCode endpoint can receive source, prompts, authentication material, and provider requests while presenting an unsupported or deliberately malformed protocol surface.
  - Query version/capabilities before readiness; reject unsupported shapes; retain existing password redaction and secret storage.
  - **Complete when:** Cafe will not send provider work to an unverified external server contract.

- [ ] **M-05 — Root UI errors expose raw stacks and local paths.**
  - **Attack vector:** an authenticated remote browser user, or an attacker able to trigger an error, can inspect stack traces and local build/server paths for reconnaissance; exception text could also contain incidental sensitive context.
  - Show safe codes/summaries; place raw diagnostics behind explicit local export or debug authorization.
  - **Complete when:** ordinary remote error UI exposes no stack, private path, or sensitive context.

- [ ] **M-14 — Dependency and vulnerability maintenance is not enforced.**
  - **Attack vector:** the current low-severity Babel advisory requires attacker-controlled source code, readable compiler output, and knowledge of a target source-map path; a crafted `sourceMappingURL` can make vulnerable Babel read that local source map into output. More broadly, unreviewed dependency drift can leave known supply-chain defects in build/runtime code.
  - Upgrade to a patched compatible Babel path or disable/validate input source maps; add automated update PRs, vulnerability gates, compatibility tests, and a release freeze policy.
  - **Complete when:** the advisory is patched/mitigated and dependency risk is a required release check.

- [ ] **L-08 — Diagnostic redaction lacks a permanent adversarial matrix.**
  - **Attack vector:** a secret placed in argv, a URL, cookie, authentication path, or environment value can cross an untested logging/diagnostic path and become readable in local logs, debug output, or exported telemetry.
  - Maintain secret-shaped fixtures across every diagnostic surface.
  - **Complete when:** regression tests prove each secret class is redacted everywhere it can be emitted.

## Bugs

These are current incorrect, unreachable, contradictory, crash-prone, or non-portable behaviors.

- [x] **RB-02 — Packaged automatic updates are unreachable.** Packaged update detection is enabled,
      stable/nightly release feeds are automated, and Linux support is explicitly x64 AppImage-only.
      Tagged releases validate all update manifests and run a lower-version packaged AppImage detection
      probe against GitHub. Windows NSIS and Linux AppImage installs remain unsigned; macOS detects the
      update but uses manual DMG replacement because Squirrel.Mac requires signing. Native install,
      recovery, signing, and notarization certification remain release-hardening work. See
      [`desktop-releases-and-updates.md`](desktop-releases-and-updates.md).

- [ ] **RB-07 — Provider availability checks accept versions outside a tested contract.** Codex and Claude detect versions without enforcing a supported base range; incompatible binaries can fail mid-turn. Publish/enforce version ranges, produce actionable health failures, regenerate Codex schemas in CI, and add supported-version fixtures/live canaries.

- [ ] **H-02 — Windows stale-backend recovery is a no-op.** The replacement-startup reaper returns no processes on Windows, so a wedged backend can keep ports/files while replacements start. Implement direct PowerShell/CIM discovery with ancestry protection and native recovery tests.

- [ ] **H-11 — Provider supervisor behavior is half-built.** A large supervisor subsystem exists, but automatic handoff is disabled because registry and active-session truth do not survive restart/fallback reliably. Prove the lifecycle invariants or remove it from production entry points, contracts, diagnostics, and builds.

- [ ] **M-06 — `NodeSqliteClient.executeStream` deliberately crashes.** It returns `Stream.die("executeStream not implemented")`. Implement the service contract with tests or make the unsupported operation impossible at the type boundary.

- [ ] **M-07 — Scoped client keys use ambiguous delimiter encoding.** `environmentId:localId` is split at the first colon even though IDs are not constrained against colons. Introduce unambiguous encoding, migrate persisted keys, and test delimiter-containing IDs.

- [ ] **M-13 — Root cleanup and release helpers are not natively portable.** POSIX commands such as `rm -rf` and shell assumptions make native Windows maintenance unreliable. Replace them with Node APIs and execute the workflows on Windows CI.

- [ ] **L-04 — `OpenInPicker` has the wrong accessibility label.** Its action group is announced as “Subscription actions.” Replace it with an accurate label and add an accessibility assertion.

## Code cleanliness

These findings primarily increase maintenance, dependency, artifact, or migration complexity rather than representing an immediate exploit or active functional failure.

- [ ] **M-04 — The production web root includes `mockServiceWorker.js`.** Move the MSW worker to test-only serving or exclude it from release builds; add an artifact assertion for test fixtures.

- [ ] **M-08 — Orphan packages, dependencies, and privileged surfaces remain.** Run package-aware analysis and remove or document `packages/tailscale`, `node-pty`, server-side `electron-updater`, scripts-package Anthropic dependencies, and the unused `cafecode:` consumer path.

- [ ] **M-11 — Large renderer and provider modules mix responsibilities.** Extract cohesive state machines, protocol translators, diagnostics, and rendering concerns from the multi-thousand-line chat/Codex/Claude modules while preserving schema/event tests.

- [ ] **L-01 — Stale T3 runtime names remain.** Rename `t3_session` and `t3CodeVersion` through a deliberate dual-read/session-expiry migration.

- [ ] **L-02 — The legacy `.t3code` VCS fallback has no removal horizon.** Keep the intentional compatibility behavior but document when and how it can be retired.

- [ ] **L-03 — Cursor compatibility references need an explicit boundary.** Preserve tested persisted-provider decoding and genuine editor identifiers while continuing to exclude Cursor from provider registries and provider UI.

- [ ] **L-05 — Package descriptions are stale.** Update descriptions such as “minimal” to match current package responsibility and maturity.

- [ ] **L-06 — The public sidebar icon appears duplicated.** Verify packaged consumers, then remove the redundant asset if unused.

- [ ] **L-07 — Release helper assertions are duplicated.** Centralize publish-preparation validation while implementing the release pipeline.

## Verification warnings

These are additional cleanup observations from otherwise passing verification and are not part of the 42 ranked findings:

- [ ] Replace the array-index React key in `apps/web/src/components/stats/ActivityHeatmap.tsx`.
- [ ] Fix or explicitly account for the browser-test `legend-list` zero-height warning.
- [ ] Remove the ineffective dynamic import reported for the environment runtime service.
- [ ] Bring the renderer main chunk under the agreed production size budget.
- [ ] Remove public production source maps; tracked above under H-09.
- [ ] Replace deprecated Node `fs.F_OK` usage.

## Stable-release exit gate

- [ ] No release blocker remains open.
- [ ] No high-priority security/privacy finding remains open or lacks explicit documented risk acceptance.
- [ ] Signed/notarized artifacts are reproducibly built from a protected tag.
- [ ] Fresh install, launch, quit, restart, upgrade, recovery, and uninstall pass on every supported target.
- [ ] Electron navigation/IPC, proxying, authentication, Web Push, attachments, and diagnostics have adversarial coverage.
- [ ] Analytics is documented, user-controlled, and independent of provider credential identity.
- [ ] Every supported provider version passes protected live and long-duration tests.
- [ ] Browser, desktop, package, dependency, artifact-content, and source-quality gates are mandatory release checks.
- [ ] Updates are fully signed/tested, or unreachable updater code/UI has been removed in favor of a documented external update model.
- [ ] Product documentation accurately states OS, architecture, provider, privacy, security, data, backup, recovery, and support commitments.

## Standard repository gates

```sh
yarn fmt
yarn lint
yarn typecheck
yarn test
yarn workspace @cafecode/web test:browser
yarn build:desktop
yarn release:smoke
```

Native installer, update, credential-backed provider, and long-duration E2E commands remain additional release gates.
