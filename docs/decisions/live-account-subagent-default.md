# Live account subagent-default inheritance

Decision status: Accepted
Created: 2026-10-10 17:22:53 JST (UTC+0900)
Last updated: 2026-10-10 18:03:44 JST (UTC+0900)
Decision authority: User requested account-default changes to apply to existing
chats at the next available safe turn, with per-chat/per-thread overrides taking
precedence, and authorized implementation and publication to dev.
Implementation status: Implemented with synthetic regression coverage. Required
repository-wide checks gate publication; native multi-OS qualification is separate.
Supersedes: [Per-chat subagent concurrency](per-chat-subagent-concurrency.md),
only its new-chat-only seeding, account fallback resolution and saved-only label presentation.
Superseded by: None

## Context

The original account default was copied into new-chat metadata once. Editing the
account preference did not affect existing inherited chats, and the sidebar's
fallback read only legacy runtime configuration. A correctly saved account limit
could therefore disagree with both the displayed and subsequently requested
policy. A default should be a continuing fallback, not a hidden explicit override.

Requested settings still cannot prove native capacity or enforcement. A running
root/child tree must retain its process configuration until existing native
whole-tree idle admission permits replacement. Settings saves are not that boundary.

## Alternatives and rationale

- Keeping seed-once behavior violates the requested meaning of account default.
- Updating every existing thread on a settings save would turn defaults into
  explicit overrides again, erase manual choices and create unnecessary durable
  writes. Old numeric values contain no origin metadata, so equality to a default
  is not evidence that they were copied rather than chosen.
- Mutating runtime instance config would trigger account retirement on save and
  interrupt active work. Editing global native configuration would also affect
  unrelated sessions and violate per-account/session ownership.

Use live resolution from existing validated settings at submission and renderer
presentation boundaries. Preserve explicit overrides and native safety guards.

## Decision

Resolve policy for the exact selected account and qualified driver in this order:

1. Its driver-specific `subagentLimits` entry, if present.
2. The selected account's validated `defaultMaxConcurrentSubagents`.
3. That account's validated legacy `config.maxConcurrentSubagents`.
4. Native configuration/environment, with no guessed numeric default.

Stop seeding account defaults into new drafts. Persist a per-chat limit only when
the user deliberately saves that override; Reset removes it and re-enables live
inheritance. A remembered value for another driver is not the selected policy.
Account default edits do not change instance runtime identity or restart/probe
providers. The reactor reads current account settings at each turn submission;
active steering keeps the prior materialized policy. Changed limits require the
existing native idle admission on a later send, including exact active/unknown
child-generation fences. No prompt is replayed to apply a preference.
Control-only goal operations and startup goal restoration are not turn submissions;
they must not materialize a newly edited default or reject solely for that pending
numeric preference. Actual subsequent turn admission still enforces it.

An inherited account number is explicit requested numeric intent, not native
inheritance. It must therefore pass the same capability gate and trigger safe
reconciliation even when an older session has no known materialized policy.
Clearing the account setting falls through to legacy/native inheritance; explicit
null still clears a prior Cafe numeric process setting at the safe boundary.

Sidebar/context/composer use one shared policy presenter and exact selected
account identity, with current process evidence independently bound to its
owning account and driver. Identify the saved source as account default or chat
override. Share the composer's existing enabled-account, driver and continuation
selection rules with the rail so a retained session and stale durable selection
cannot produce a different displayed account; actual routing is unchanged.
Compactly show current and saved policy when they differ, for example
`Subagent limit: 5 → 15 when idle`; this is conditional on native idle authority,
not a promise that the immediately next turn is idle. A cleared saved number
must still show a known current number pending a return to provider inheritance.
Unknown process evidence never becomes a guessed native default; an unmaterialized
saved number is marked saved. Both-unknown numeric policy remains hidden. Keep
further explanation in the accessible tooltip/editor, not additional sidebar rows.
The display is not an independently verified hard cap.
Default model/effort preferences remain new-chat-only and are not changed here.

## Security, privacy, and failure consequences

This changes policy selection, not provider execution or transport authority.
The same bounded numeric schema, supported-driver gate, exact selected account
routing, native whole-tree idle/retirement lock, typed pure-limit refusal path,
and acknowledged renderer policy overlays remain authoritative. Unknown child
liveness, uncertain teardown and account/model/cwd changes never authorize a
competing process or prompt retry. All explicit chat/account numeric turn entrypoints reject
unsupported/unknown runtime capability without silently discarding user input.
Control-only goal/compaction operations retain their separate admission boundary.
Renderer submission guards re-read the exact owning account after asynchronous
preparation and before dispatch or a durable queue claim. Numeric intent that
becomes unsupported during preparation remains definitely unsubmitted, with the
original prompt/queue row available for correction rather than an ambiguous retry.
An active legacy session without recorded account identity cannot use a different
selected account's capability as authority for numeric steering intent; retain
the input until an ordinary safe idle submission can establish the exact owner.

No new credential reads, provider calls on render/save, global environment edits,
provider installations, diagnostic payloads, or platform-specific launch policy
are introduced. Existing registry identity tests must continue to prove that
changing/clearing a default alone leaves adapters/subscriptions intact.

## Compatibility and operational consequences

Keep the existing settings, thread map and nullable session contracts; no data
migration or new wire fields are needed. Historical numeric per-chat/draft values
are preserved as overrides because their origin is unknowable. A user can Reset
one to inherit the live account default. Fork/duplicate retain explicit choices;
threads without them inherit their selected account at subsequent submission.

Existing native Codex/Claude translation, capability versions, limits, query
environment isolation, ownership, and macOS/Linux/Windows process behavior are
unchanged. Rebuilding and normal updated backend/session adoption are required;
this change does not repair a running live provider before that adoption.

## Implementation and evidence impact

Server policy resolution and `ProviderCommandReactor` must read the typed account
fallback. Shared web concurrency presentation/admission, composer draft creation,
standalone draft creation and Settings copy must remove seed-once assumptions.
The [user guide](../subagent-concurrency.md), contracts comments and AGENTS provider
policy explain inheritance and safe application.

Synthetic policy/reactor fixtures qualify exact account selection, bounds,
override/reset/clear, legacy unknown session adoption, busy steering followed by
idle adoption, capability rejection and conservative native refusal. Real-browser
fixtures qualify saved sidebar/editor display, changing defaults, non-seeded
drafts, account routing and prompt retention. Run required repository checks and
full browser coverage, then the forced desktop build last. Local qualification is
not live provider enforcement or native multi-OS evidence; hosted checks are separate.

## Supersession and preserved decisions

The predecessor remains the record of the accepted seed-once design and its
rationale. This decision replaces new-chat-only default copying, fallback
resolution and saved-only label presentation. Driver-keyed explicit maps, reset/omission semantics, nullable known
materialization, migration 81, strict capability, acknowledged exact-thread
overlays, child lifecycle/public-history privacy and safe native admission remain
in force unchanged.
