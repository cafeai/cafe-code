# Claude 318 compatibility and Windows Codex launch integration

Created: 2026-11-04 11:20:36 JST (UTC+0900)
Last updated: 2026-11-04 12:05:37 JST (UTC+0900)

This update selects Claude Agent SDK **0.3.318** and managed Claude Code
**2.1.318** together. The three SDK pins and the managed Windows wrapper/x64/arm64
manifest entries move together. Codex remains **0.166.0**; the Windows launcher
repair changes Cafe's command construction, not the provider version or protocol.

Package admission and repository dependency installation have passed. The complete local verification graph, fresh final desktop build, hosted CI
and local bundle delivery separately qualify the resulting commit. Package
admission does not establish those outcomes or selected native-provider adoption.

## Frozen upstream and the exact age exception

The reviewed SDK tag resolves to
[`040a7f855da8261c795d975e116f40bb042334f7`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/040a7f855da8261c795d975e116f40bb042334f7),
and the CLI tag to
[`646b74189c735abbccf78ef5cb7ddd38a07a36eb`](https://github.com/anthropics/claude-code/tree/646b74189c735abbccf78ef5cb7ddd38a07a36eb).
The official release notes are [SDK 0.3.318](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.318)
and [CLI 2.1.318](https://github.com/anthropics/claude-code/releases/tag/v2.1.318).
At selection, npm `latest` named this pair; CLI `stable` still named 2.1.311.
These mutable channel labels are distinct. The reviewed version stays fixed.

The user explicitly waived the elapsed 24-hour age hold for this **318 pair
only**. The normal complete-family hold would end at
**2026-11-04 21:59:39.224 UTC** (2026-11-05 06:59:39.224 JST).
The [317 exception](provider-updates-2026-11-03.md) remains historical and is
not used as authority for this update.

All **18** exact wrapper/platform archives passed publication-time, SHA-512 and
SHA-1 integrity, embedded manifest/platform checks, and **36** npm registry
signature checks. The admission receipt's SHA-256 is
`a27d1ebcc621e7780a33cce1f928750010cefd4394ab985db92921a6e15944b7`.
The repository install used transient preapproval for only the nine exact SDK
318 descriptors, followed by a normal immutable install without that override.
Package scripts remained disabled and the persistent age policy did not change.
Registry signatures do not prove native behavior or source-to-binary
reproducibility.

## Sign-in expiry is an observation

The integrity-checked SDK declarations add `credential_expires_at` to numbered
success and error results. It is an ISO instant for the stored claude.ai login's
refresh-chain end, read when that result is written. Renewing an access token
does not move it. The value can be a server date or a 30-day estimate, and the
real end can be up to three days earlier. A past date is not proof of remote
rejection; revocation can also happen before the displayed date.

The field is absent for unknown dates, API keys, environment tokens, other
providers, unnumbered results and older producers. Missing data must remain
unknown. Cafe's nonblocking advisory shows an estimated
active-session sign-in deadline, including a ten-day advance warning, without
changing authentication state or granting account-selection authority.

The metadata remains volatile and tied to independently initialized native
query owners. It must not survive through persisted status caches or conclusive
authentication-label retention. The [metadata advisory decision](decisions/claude-provider-metadata-advisories.md)
defines admission, retirement, presentation and qualification boundaries.

The CLI also adds `loginExpiresAt` to `claude auth status`. This update does not
add another status probe or change the existing login-environment selection
merely to obtain that field; it consumes the supported result metadata instead.

## Invalid configuration guidance

SDK 318 adds the closed startup reason `config_file_invalid`. Genuine startup
results can precede initialization and identify a failed native session that
must not replace Cafe's prior durable resume cursor. The new diagnostic
presentation uses fixed repair guidance and a finite reason. It does not
overwrite configuration, copy native paths into the new guidance, change Stop,
reclassify authentication, or change retry policy.

Canonical lifecycle error handling and its existing diagnostic/logging policy
remain separate from this fixed presentation; this update does not claim to
remove arbitrary configuration text from all historical or native logs.

## Compatible native changes

SDK 318 expands interrupt receipts for inputs held behind a model change.
Cafe retains the public parameterless interrupt followed by cancellation of
only its own pending UUIDs. Unknown UUIDs remain outside Cafe's cancellation
authority, and uncertain cancellation retains the existing retirement behavior.
The public declaration does not add an interrupt argument to this interface.

Subagent progress summaries may wait up to five minutes on a cold prompt cache
and may be omitted when the subagent finishes first. Summary absence is not a
terminal lifecycle event. `PushNotificationInput.status` becomes optional;
Cafe's existing native notification handling does not require that input field.
These changes do not justify fabricated summaries, altered liveness deadlines,
or replayed commands.

Native CLI fixes include macOS Bash-command stalls and memory growth, interrupted
session persistence, Stop/model-change races, false headless success under mod
hooks, and configuration/login saves on network homes. Those improvements
require the native executable containing them. Cafe passes each configured
executable to the SDK; updating the imported SDK or fresh-install manifest does
not replace an already selected external installation or restart running work.

## PR 119 integration boundary

[PR 119](https://github.com/cafeai/cafe-code/pull/119), reviewed at
[`97450312258190a960c8620649414f2fe1bf5bb9`](https://github.com/cafeai/cafe-code/commit/97450312258190a960c8620649414f2fe1bf5bb9),
centralizes Windows Codex command construction and preserves scheduling TOML
through batch shims' argument-forwarding passes. Integration preserves current
native fixture ownership, environments, cwd, stdin, process options and the
separate POSIX copied-native test tail.

Review also found a quoted-semicolon PATH resolution gap and a pre-existing
raw-shell fallback for missing/unsupported commands. The integration repairs
those boundaries rather than treating successful batch quoting as universal
shell safety. Native Windows synthetic-peer CI remains required; macOS policy
tests do not qualify Windows argument delivery. See
[the command fixture guide](codex-command-fixtures.md).

## Qualification and replay

Controlled regression baselines reproduced missing expiry transport,
volatile-metadata retirement, invalid-config presentation and unresolved Windows
command refusal. These intentionally failed checks establish the old behavior,
not successful integration. The affected Claude adapter, expiry helper, status
cache and managed-provider files subsequently passed 417 tests; contract and
pure diagnostic/presenter checks passed separately. The local command/client
checks passed 94 tests, with eight Windows-only cases skipped on macOS.
These scoped checks do not substitute for complete qualification.

Use the pinned Node and Yarn workflow documented in
[test performance](test-performance.md): `corepack yarn verify:local` includes
format/lint/audit, actual Effect compiler diagnostics, complete type/Node/browser
coverage and the fresh forced desktop build last. Preserve exact-input reuse
labels, isolated native groups and all resource/deadline controls. The resulting
dev push must independently pass its exact native CI jobs and artifacts;
macOS checks do not establish Windows batch delivery. Safe local bundle delivery
requires fresh source/dependency/build identity and byte-bound output receipts,
retaining live assets without restarting Cafe or provider sessions.
