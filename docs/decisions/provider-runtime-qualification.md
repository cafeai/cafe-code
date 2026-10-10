# Owner-local provider capability qualification

Decision status: Accepted within the authorized repair
Created: 2026-10-10 19:27:48 JST (UTC+0900)
Last updated: 2026-10-10 19:44:06 JST (UTC+0900)
Decision authority: Agent implementation discretion within the user's request to
fix repeated configured Codex subagent-limit refusals and publish the repair.
Implementation status: Implemented with isolated synthetic regression coverage.
Required repository checks gate publication; hosted native qualification and
live account capacity remain separate evidence boundaries.
Supersedes: None
Superseded by: None

## Context

Native capability getters use version evidence captured by their own adapter's
driver. Backend and detached daemon drivers live in different processes. A
backend status probe cannot initialize the daemon's version closure. Managed
Codex and Claude providers deliberately delegate initial probe admission to
`ProviderRegistry`; omitting that owner from the daemon graph leaves native
qualification unknown and periodic checks unstarted.

Simply awaiting every account's full initial health probe before starting the
daemon listener introduces a different failure: bounded two-wide account waves
can exceed the existing desktop/supervisor readiness deadline. Those deadlines
and process ownership rules must not change to accommodate status inspection.

## Alternatives and rationale

- Trusting backend or another account's status breaks exact-owner qualification.
- Independent driver/capability-call probes bypass aggregate admission bounds.
- Awaiting all probes before listener startup risks readiness failure as account
  count grows; extending readiness deadlines conceals that coupling.
- Reusing the backend's durable cache inside the daemon adds a competing writer
  and stale presentation evidence without initializing a native version closure.

Use the existing status owner inside each native runtime, with daemon-only
background admission and exact-generation read barriers. Keep the backend's
existing awaited, cache-enabled behavior unchanged.

## Decision

The local daemon graph shares one hydrated instance registry and one adapter
facade between service routing and inventory. Its status registry disables both
cache hydration and persistence. Mutation subscription and boot generation
barriers exist synchronously before the layer returns. The same scoped,
serialized registry admission runs in the background with at most two initial
probes per owner. Existing settings replacement and stream-generation fences
remain in force.

Capability reads await the selected generation's existing admission, not a new
refresh. They recheck routing after completion and never use a retired adapter's
true result for a replacement. Missing or failed native version evidence settles
admission without granting support. A successful version observation may survive
a later authentication-health failure; version-based support is not proof of
usable credentials. Failed Claude version launches retain no parsed version or
raw launcher output in their failure message. A registry setup failure completes only that pass's pending generation
barriers with a fixed content-free provider request error, rather than leaving
readers waiting forever or releasing an unqualified getter. Retired failures
cannot poison a newer owner. Reader cancellation cannot cancel owner-scoped admission. Inventory and
health do not wait for probes or initiate provider calls. Remote-supervisor
selection and native session/control/idle-replacement behavior remain unchanged.

## Security, privacy and failure consequences

Unknown, malformed, unsupported and prerelease versions cannot certify support.
The shared version parser preserves complete prerelease tokens and refuses
unsupported build metadata rather than truncating it into stable qualification
or feeding lexical fallback into minimum-version comparisons.

The authenticated capability wire contract remains unchanged. Optional rich-health
qualification counters expose only known-version, unknown-version and reported
pending counts from existing owner snapshots. They contain no account identity,
versions, paths, prompts, output or credentials and never authorize execution.
The reported pending count is not the number of unresolved admission barriers:
a failed native snapshot operation can retain its last pending presentation even
though the owner barrier has settled fail-closed.
Absence in an older daemon is unavailable evidence, not success or zero counts.

## Compatibility and operational consequences

No provider is installed, no profile is edited, no failed input is replayed and
no active runtime is automatically stopped by this repair. An adopted daemon
continues running its existing code. Applying the new daemon graph requires a
deliberate safe user-requested runtime restart, described in
[the concurrency guide](../subagent-concurrency.md). There is no dependency,
native version-floor, launch-policy or readiness-deadline change.

## Implementation and evidence impact

Source boundaries are `ProviderRegistry`, the local `ProviderDaemonRuntime`
graph, read-only `ProviderService.getCapabilities`, runtime inventory/health and
the allowlisted compact desktop debug projection. Synthetic production-graph
fixtures must qualify two-wide background admission, listener readiness during
held probes, exact-instance barriers, replacement/cancellation, periodic release,
cache isolation and authenticated capability/health transport without provider
executables, credentials, inference or process reaping. Shared parser and native
floor fixtures retain stable, malformed and prerelease behavior. Local fixtures
do not establish a particular live account's capacity or native multi-OS behavior.

## Preserved decisions

This supplements [per-chat concurrency](per-chat-subagent-concurrency.md) and
[live account defaults](live-account-subagent-default.md); their precedence,
numeric bounds, exact ownership, current/saved presentation and whole-tree idle
admission remain unchanged. It does not replace either accepted decision.
