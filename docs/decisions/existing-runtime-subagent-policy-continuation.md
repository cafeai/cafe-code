# Follow-ups under an unchanged native subagent policy

Decision status: Accepted within the authorized follow-up repair.
Created: 2026-10-11 10:54:53 JST (UTC+0900).
Last updated: 2026-10-11 11:16:48 JST (UTC+0900).
Decision authority: Agent implementation discretion within the user's request to
repair blocked Codex follow-ups and include the repair in the current dev push.
Implementation status: Implemented; focused qualification passed, final gates and delivery pending.
Partially supersedes: [Per-chat concurrency](per-chat-subagent-concurrency.md)
only where a numeric-intent capability check would reject an unchanged,
already-materialized policy on the same still-owned native process.

## Context and rationale

Native support for applying a numeric subagent limit comes from the configured
runtime's owner-local version observation. A later inconclusive version probe
must not certify a new process, even if an older observation qualified. However,
rejecting every numeric-intent follow-up also blocks an existing process whose
unchanged numeric policy requires no new configuration. Active children do not
make another account, process, or setting safe to reuse.

Remembering a successful version indefinitely could admit an unknown replacement
binary. Treating a saved session number as proof of native capability would make
presentation data execution authority. Removing only the reactor's early check
would leave a race in which ordinary service recovery could construct a new
process after the checked one disappeared. These alternatives are rejected.

## Decision

Keep native `subagentConcurrency` support separate from an additive Cafe owner
guarantee, `subagentPolicyContinuation`. The latter certifies the owner's ability
to enforce an exact-process, no-recovery continuation fence; it is not a claim
about the CLI version, actual worker capacity, or a new configuration.

Only a no-replacement operation with the identical known numeric policy may use
that guarantee. Bind it to the exact thread, selected provider instance, native
subagent runtime generation and materialized number. Carry this
`expectedSubagentPolicySession` tuple through authenticated send and steer
transport to final admission under the native lifecycle lock. A missing,
retired, changed, or differently configured runtime must refuse; the fenced
operation must never recover by starting a process or silently lose its fence
on an active-turn fallback.

Fresh sessions, owner/driver changes, numeric changes, unknown materialization,
and any other condition requiring process replacement still require the selected
runtime's explicit native support. Renderer evidence is only an advisory
preflight: the local fleet flag advertises backend implementation availability,
not proof that an adopted daemon supports it. The backend separately reads the
authenticated owner's capabilities and fresh inventory before dispatch. An older
owner that omits the guarantee cannot qualify the exception, even if the new
backend's advisory preflight permits submitting the draft.

## Security and operational consequences

No native version floor is lowered, no probe is added, no profile is edited and
no rejected input is automatically replayed. An observed number alone never
grants the exception. Existing Stop, later-input, uncertain acknowledgment,
root/child ownership and replacement fences remain in force. Errors and debug
data retain bounded fixed classifications, not raw provider output.

The additive protocol requires a rebuilt owner as well as the consuming backend
and renderer. Reloading a UI that adopts an older daemon does not add its
guarantee. Normal deliberate adoption is required; source tests do not establish
that a particular live refusal was caused by an inconclusive probe.

## Implementation and verification boundaries

Affected boundaries are shared provider/daemon contracts, remote decoding,
capability projection, reactor session selection, ProviderService routing,
Codex final native admission and renderer numeric-intent preflight.

Isolated fixtures must prove same-policy continuation, wire fidelity, lifecycle
replacement races, no automatic recovery, and rejection of changed/missing/
foreign tuples and legacy capability omission. Fresh unsupported starts and
policy changes must retain their original rejection. Run the repository-pinned
formatting, lint, typecheck, full tests and affected browser fixtures, followed
by `corepack yarn build:desktop --force` last. Live provider capacity and native
multi-host qualification remain separate from local synthetic evidence.

Focused qualification passed 611 backend tests, 41 policy-entrypoint cases and
13 daemon contract tests. Renderer qualification passed 11 advisory unit tests
and the complete 49-case standalone ChatView browser part, including exact-owner
follow-up, queue and post-preparation capability revocation. Server and web
typechecks passed. Independent source/ownership audit is closed; repository-wide
gates remain required before delivery. These counts do not claim live capacity
or repair adoption.

The [owner-local qualification decision](provider-runtime-qualification.md),
[live account-default precedence](live-account-subagent-default.md), native idle
replacement requirements and compact current/saved presentation are preserved.
