# Owner-managed pending questions through Cafe MCP

Status: Accepted design; execution and delivery evidence are tracked separately.
Created: 2026-11-05 07:47:16 JST (UTC+0900)
Last updated: 2026-11-05 07:47:16 JST (UTC+0900)
Authority: User requested pending-question discovery, complete details,
answering, skipping and clearing through Cafe MCP, with visible primary-chat
resolution notices containing the question and submitted answer/disposition.

## Context

A durable chat can contain both provider-native user-input callbacks and
saved inline asynchronous questions. They have different completion semantics.
A native response is asynchronous work owned by an exact provider callback;
an inline answer is an ordinary durable user message and send intent. Neither
a management dispatch acknowledgement nor native method return proves that a
callback was canonically settled. Questions older than the recent activity
tail must remain addressable without loading a multi-day transcript.

The management endpoint already grants owner authority over explicit Cafe
chats. This feature does not expand that audience, approve permission
requests, change provider modes or grant a session authority over an unrelated
native callback. Native adapters retain their own final ownership checks.

## Decision

Register `list_thread_questions`, `get_thread_question`,
`answer_thread_question`, `skip_thread_question` and `clear_thread_question`.
Require an explicit Cafe thread ID. Read-only summaries expose stable targets
and capability flags; full details require the separate exact-target read.
Use the existing owner-authenticated management gate for all five tools.

Native targets bind opaque request ID and exact request creation time. Preserve
identifier bytes, including valid opaque record keys such as `__proto__`.
Validate inert own data, finite encoded size, complete exact question-ID
coverage, disjoint answer/unanswered maps and supported dispositions at the
MCP boundary and again at authoritative command decision. Empty option arrays
remain valid freeform questions. Duplicate IDs, malformed questionnaires and
provider-specific interaction forms cannot become generic answer authority.
Missing unanswered capability refuses skip/dismiss; never synthesize an empty
answer. Approval callbacks are a separate protocol and remain untouched.

Native answer/skip/clear uses internal-only
`thread.mcp-user-input.respond`. It is excluded from the public client command
union, so renderer input cannot mint MCP provenance. Under the SQLite writer,
re-read the exact saved request/resolution lifecycle and fresh thread shell.
Reject missing, stale, archived or deleted owners. Ordinary response failure
does not erase the original request. The durable event records server-authored
MCP intent separately from provider data. Its receipt says
`provider-confirmation-required`; canonical callback settlement, not enqueue,
method return or failure prose, governs completed resolution and its notice.

Inline targets bind canonical saved activity ID and normalized question index.
Internal `thread.async-question.answer` rehydrates the exact activity under
the writer, rechecks current handled indexes and fresh thread settings, and
expands into the ordinary start-or-steer path. Preserve ordinary durable user
message identity checks. The quoted answer message, turn intent, handled
index and MCP notice commit in one transaction; a failed part rolls back all
parts. Internal `thread.mcp-async-questions.resolve` records explicit skip or
clear and its notice in the same transaction, without a turn or invented
answer. Existing renderer handling retains its separate public command.
An inline `recorded` receipt attests durable handling, not provider acceptance
or paid execution. Unknown mutation acknowledgement requires a fresh read,
never an automatic replay.

## Reads, privacy and retention

`ProjectionSnapshotQuery.getThreadQuestionContextById` returns a thread shell,
bounded activities and `pendingRequestRetentionTruncated`. It reuses the
existing pending-callback retention SQL and legacy ordering repair without
hydrating transcript messages, proposed plans, checkpoints or native provider
history. Native pending requests retain exact unresolved payloads independently
of root completion, clicks and age. A bounded retention omission remains
explicit and cannot prove an empty chat.

`getThreadAsyncQuestionActivitiesPage` is a thread/kind-indexed keyset read,
with default 20 and maximum 64 inspected activity records per page. Order by
immutable creation time and activity ID, not the mutable handled-update ledger
sequence. Advance from the last inspected row even when its payload is
unreadable; report omitted records instead of silently stopping. One activity
can contain multiple questions. `getThreadAsyncQuestionActivity` reads one
exact canonical activity/thread/kind and applies the same finite body limit.
These reads reach cold old questions beyond the ordinary activity tail.

Every list page repeats the current native callback view, while inline counts
are page-local. A subsequent page or any omission cannot establish whole-chat
absence. Return unknown rather than false for an empty incomplete view. Bound
complete detail responses and refuse oversize wording rather than truncating
actionable questions or options. Expose fixed failure text, not raw SQL/native
errors, credentials or unrelated chat content. No read starts a provider,
renews ownership, probes an account or runs inference.

## Primary-chat provenance

Use a versioned server-authored `mcp.question.resolved` activity rendered as
primary timeline content. Show the exact saved question and submitted answer
or explicit skip/dismiss disposition, with MCP attribution. This is human
presentation data, not a system message added to the model conversation.
Native provenance joins the original exact request incarnation to canonical
settlement; a pending dispatch or native method return must never publish a
success notice. Inline notices are atomic with their recorded handling.
Split mixed native answer/unanswered dispositions accurately rather than
labelling an entire questionnaire answered.

Retain the newest eligible prefix subject to both a 64-notice limit and a
cumulative 1 MiB encoded-payload budget beyond the normal activity tail.
Already-present tail data costs no additional retention bytes; a large older
notice may exhaust the byte budget before 64 notices. Validate kind, versioned
payload, bounded exact details and server-authored provenance before rendering.
This finite visibility budget does not discard unresolved callbacks or promise
unbounded historical notice hydration. Notice identity supports idempotent
reconciliation; it never authorizes another callback response.

Native intent acknowledgement does not promise a retroactive receipt after
backend interruption. A callback may be consumed before a corresponding notice
becomes durable. Retired or uncertain correlation fails closed; matching saved
intent and answers alone cannot prove that MCP, rather than another client,
won that callback. Reconcile canonical pending state without replaying the
response or manufacturing MCP provenance. A stronger cross-crash guarantee
would require an independently qualified durable acceptance/correlation
protocol at the native callback-consumption boundary.

## Verification boundary

Primary regression owners cover internal/public contract separation; exact
database pagination, omission and cold-history reads; transcript-free context
hydration; transaction rollback, durable message identity and stale/concurrent
answer refusal; opaque native question IDs through persisted events; and the
difference between queued acknowledgement and canonical settlement. MCP
transport and primary-timeline tests cover their distinct schema/visibility
boundaries. Authored tests are not evidence that they were executed. Native
provider adoption, live account access and real callback execution require
separate qualification and are not implied by a source change or bundle.
