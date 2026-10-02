# Decision: record prospective model generation time independently of tokens

Decision status: Accepted
Created: 2026-10-02 22:43:54 JST (UTC+0900)
Last updated: 2026-10-02 23:09:22 JST (UTC+0900)
Decision authority: implementation choice within the user's explicit request to begin tracking generation time per model and display it beside cost and tokens.
Implementation status: Implemented. Focused schema, SQLite, service and UI tests pass; repository-wide publication gates remain mandatory.
Supersedes: None. Supplements the existing daily elapsed-time and token accounting policies.

## Context

Cafe records elapsed active-turn time by server-local day and records token usage independently by provider/model/day. Historical token totals do not establish how long each model was active. Retained turn projections cannot recreate collection-disabled intervals, effective model reroutes, processing-clock boundaries or missing observations accurately. Metadata helpers and subagent token observations also do not establish measured interactive turn duration.

## Decision and rationale

Add a separate numeric model/day generation-time ledger, keyed by local day, canonical provider driver and bounded effective model label, plus singleton persisted tracking-start metadata. Begin prospectively; never divide old aggregate time by token shares or replay paid work to recover it. Record the same observed active-turn wall time as the existing aggregate: tools and waits are included, and concurrent turns each contribute their own duration. This is not a model inference-time metric.

Accrue an open interval before replacing its attribution or collection-enabled state. Unresolved attribution uses the existing explicit unknown category, not a guessed requested model. Persist model-time, aggregate and token increments in the same flush transaction and restore pending batches together after failure. Once admitted, an additive flush settles its transaction and acknowledgement before honoring cancellation: an interrupted waiter must not replay an already committed batch. Include current unflushed/in-flight time in the low-cadence detailed response without mutating persisted counters merely because the UI reads them.

Expose this dimension as an optional additive `modelGeneratingTime` object in `UsageStatsGetResult`; retain the fixed-cardinality high-rate snapshot contract. Older saved servers can omit it without breaking the Usage page. The shared Settings/Atrium cost table joins time independently of cost/token calculations, includes time-only rows and follows the selected calendar period. A missing model measurement reads “Not recorded,” including token-only helpers after tracking began. Coverage copy identifies the persisted start so measured new intervals cannot be mistaken for historical lifetime timing.

Retrofitting time into old token rows with a zero default was rejected because zero would incorrectly claim a measurement. Reconstructing old work from transcripts or allocating time proportionally was rejected because it is unbounded or speculative. An independent ledger preserves token accounting and admits aborted or in-flight work that has not reported tokens.

## Security, compatibility and operational consequences

Store only canonical provider driver, inert bounded model label, calendar key, canonical UTC timestamp and nonnegative safe-integer duration. Missing/corrupt metadata or an unsafe summed duration makes the optional timing dimension unavailable rather than displaying invented, rounded or partial timing; aggregate/token accounting remains independent. No prompts, outputs, configured account identifiers, native session/request identifiers, credentials or filesystem paths enter the ledger or diagnostics. Existing authentication, provider execution, process ownership and sandbox permissions remain unchanged; tracking consumes no additional inference tokens and launches no helper/provider calls.

Hydrate once and derive detail from memory; do not add SQL scans, model-resolution calls, per-model animation loops or high-cardinality live payloads to the token hot path. SQLite migration is additive and leaves existing aggregates untouched. No Windows-specific behavior is introduced: macOS/Linux/Windows use the same time accounting and portable SQLite path. Graceful shutdown flushes measured time; a hard stop retains the existing bounded flush-loss limitation rather than inventing unobserved intervals after restart.

## Evidence and acceptance

Focused tests cover migration without historical fabrication, persistent metadata across restart, atomic rollback/retry and commit acknowledgement, repeated starts, model switches, concurrent turns, midnight boundaries, clock corrections, collection toggles, termination and live detail without double counting. Schema tests cover old-server omission, invalid metadata/counters/labels and overflow. Range/presentation/browser tests cover missing history, time-only rows, all date ranges and narrow/wide shared table layouts. Required repository checks and a final forced desktop rebuild gate publication. See [usage statistics](../usage-statistics.md) for implementation and replay guidance. Tests use isolated SQLite and synthetic provider/clock fixtures; they do not claim native provider qualification on untested operating systems.
