# Readable provider error rows

Decision status: Accepted by the user's request to make provider errors readable
Implementation status: Implemented; qualification boundary below
Created: 2026-10-19 23:32:04 JST (UTC+0900)
Last updated: 2026-10-22 07:17:54 JST (UTC+0900)
Extends: [Private provider retry/error details](private-provider-error-diagnostics.md)
and [Provider errors stay out of chat popups](provider-error-popup-policy.md).
Their capture, storage, ownership, private-reader and no-popup rules are unchanged.

## Context

A survey of one long-lived local profile (Oct 5–18) found that the Work Log
rows were accurate but hard to act on:

- Every failed Codex turn appeared twice ("Runtime error" + "Provider error").
  Codex 0.157+ sends `startedAt`/`completedAt`/`durationMs`/`itemsView`/
  `rootTurnId` on terminal turns. The adapter omits those (and items) from the
  copy, which set the snapshot-wide `omittedFields` flag and disabled echo
  folding even though the copied error object was identical.
- A signed-out turn produced seven rows (five reconnects, two errors) and no
  row said "sign in". Collapsed rows said only "Provider error".
- Expanded rows led with seven identifiers and three stacked disclaimers; the
  message appeared twice (prose and JSON).
- Claude failures were "Agent not recorded", repeated Claude Code's CLI-only
  advice ("run /login", "run /usage-credits") and included Cafe's chat id.
- Codex stderr continuation lines (for example source lines quoted by a failed
  `apply_patch`) each became a durable "Runtime warning", hundreds per day.
- Planned restarts produced false "exited unexpectedly" errors on every open
  chat: the desktop stops the detached daemon through its child handle, which
  signals the whole process group, so provider children exit at the same time.
- Claude `dev_intent` telemetry surfaced as an "Unhandled … subtype" warning.

## Decision

**Closed category.** Ingestion derives a `ProviderDiagnosticCategory` from
structured fields of the private copy only: Codex `codexErrorInfo` (with an
`httpStatusCode` refinement for 401/403/429/529), Claude typed
`SDKAssistantMessageError` codes or result `api_error_status`, and Cafe-owned
process-exit methods. Provider prose (`message`, `additionalDetails`) never
selects a category. The value is published as the activity payload key
`providerDiagnosticCategory`, beside rather than inside the strict v1 summary,
so older renderers keep reading summaries. Older rows derive the same category
from the admitted private copy after explicit expansion. A category selects
fixed Cafe copy and navigation only; it grants no retry, recovery, permission
or lifecycle authority. Unknown/future codes stay uncategorized.

**Claude Stop.** A separate adapter correction handles the diagnostic-only
`error_during_execution` returned by Claude after an ordinary Stop (upstream
[SDK #366](https://github.com/anthropics/claude-agent-sdk-typescript/issues/366)
and [SDK #405](https://github.com/anthropics/claude-agent-sdk-typescript/issues/405)).
Only a successful native interrupt bound to the same query, Cafe turn, native
session and submitted prompt witnesses qualifies the exact single internal
summary with `stop_reason=null` or `tool_use`. The result becomes interrupted
without an error message or provider-error row; the existing accepted-interrupt
receipt displays as "Response stopped". Each result consumes this evidence,
and a response revision fences a late receipt from qualifying a later segment.
Pending/rejected interrupts, stale turns, foreign sessions/correlations,
primary typed errors, reported API status, other terminal reasons and additional
error text keep their original failure behavior. SDK 0.3.295 documents clean
receipt-before-result ordering and the crash-result-before-receipt exception;
that exception cannot borrow later acceptance. No request is replayed and the
query remains open. Existing native diagnostic logging and historical error
records are unchanged.

**One row per failure.** Terminal echo folding judges completeness on the
copied error object: a capture marker inside it (redaction, omission, cut)
still keeps occurrences distinct, but unrelated omitted turn fields do not. A
terminal copy that carries only a message folds into an earlier error with the
exact same complete message, Cafe thread/turn and runtime generation. The
renderer additionally folds rows persisted by older builds using the existing
content-free `providerErrorHash`/`providerErrorOwnerHash` witnesses, keeps only
the newest of consecutive same-agent reconnect observations, and folds a
reconnect run into the error it ended with ("… after 5 reconnects"). All
activities and private copies remain persisted.

**Panel layout.** The collapsed row names the category. The expanded panel
leads with fixed guidance (and, for older rows, the derived title), the
recorded Daybreak state for cyber-policy errors, reconnects observed before
the error, and at most one navigation button: model picker, model options or
provider settings, always for the owning chat's composer, never another Desk
pane. The provider message follows once. Identifiers, the capture note (one
line), JSON and copy actions mount only after "Technical details" is opened.
Accepted-turn settings now record Codex Daybreak (`daybreak`; absent means not
recorded, never Off).

**Attribution and wording.** Claude primary-query failures are root failures
with a Cafe-built `{ message, errorType?, apiErrorStatus? }` body reused on the
terminal turn so the pair folds. Stream failures show the process detail
without Cafe's chat id. Superseded Claude auth warnings and retired
"Unhandled … subtype" warnings join the shared hidden-warning list used by
both live and historical Work Log queries; durable diagnostics keep them.
Codex's exact official "Falling back from WebSockets to HTTPS transport."
warning is labelled "Switched to HTTPS (WebSocket unavailable)" with the
received text kept as detail; no transport policy changes.

**Noise and shutdown.** Codex stderr continuation lines after a tracing record
are dropped; tool-router, model-catalog refresh and missing-tool-output records
stay in native logs only; identical records repeat at most once per five
minutes. Rust panic headers remain records. The CLI entrypoint records receipt
of SIGTERM/SIGINT/SIGHUP. Codex and Claude exit observers wait at most 750 ms
(wall clock, since tests virtualize the Effect clock) for that evidence and
then report a graceful stop instead of an unexpected exit. A real crash is
still reported, at most that much later. Claude `dev_intent` is consumed
quietly like `session_title_changed`.

## Alternatives rejected

Parsing prose such as "unauthorized (401)" or "/login" into categories;
putting the category inside the strict v1 summary (older renderers would reject
it); deleting or rewriting historical rows; automatic retries or account/model
changes from a button; a sleeping grace window on the Effect clock.

## Qualification boundary

Synthetic tests cover category derivation and refusal of prose, echo folding
with omitted turn fields and message-only copies, the Codex terminal shape in
ingestion, Claude root attribution/typed errors/folding, the shutdown and
stderr classifiers, renderer folding/labels, and the browser disclosure
(guidance, action, collapsed technical details, locale labels). These are not
live provider, native desktop restart or release qualification. Rebuilt
backend/daemon adoption is required for server changes; historical rows gain
only renderer-side folding and expansion-time categories.
