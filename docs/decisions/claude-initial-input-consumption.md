# Decision: bind an initial Claude input to its consumed new turn

Decision status: Accepted design for the reported late-steer/new-turn repair
Implementation status: Implemented in the provider input contract, native adapter and steering presentation
Verification scope: The targeted regressions and transport/retention qualifications below; running-instance adoption is separate
Created: 2026-11-10 16:49:40 JST (UTC+0900)
Last updated: 2026-11-10 17:32:04 JST (UTC+0900)
Decision authority: The user's request to repair Claude input left in Steering
while background work remains, and to publish the verified fix to dev.

## Relationship to the predecessor

This is a narrow successor to [Claude steer consumption](claude-steer-consumption.md).
It extends only the predecessor's restriction to locally admitted live steers
and its captured old-turn/runtime equality when an ordinary late steer is
authoritatively accepted as a new turn. The predecessor's native-consumption,
primary-init, one-shot, retention, privacy and no-replay rules remain in force.
Its live-steer and legacy receipt paths keep their exact owner matching.

## Context and demonstrated boundary

Attachment preparation and transport can outlive the root turn the composer
observed. When the committed ordinary steer reaches a ready backend, the
decider intentionally creates a new turn-start intent for the same saved user
message. Before this repair, that initial-input path did not carry its committed
intent sequence into Claude's consumption lease, while the pending renderer
row still named the preceding turn. A real native answer could therefore lack
the exact processing witness the shelf required. This is a source-level race;
the screenshot alone does not prove the historical input's delivery or cause.

Background tasks, session state and a root turn are separate lifetimes. A count
of running tasks, an idle status or an unrelated assistant response cannot
identify which locally submitted message reached the primary model.

## Source-owned initial-input consumption

Carry the actual committed turn-start intent sequence and message identity as
optional inert provider-input correlation. Validate the sequence as a safe
nonnegative integer; never invent one for legacy calls. Forward the same value
through the existing send-to-live-steer fallback, without treating that fallback
as a new native start. This metadata grants no permission, retry or routing
authority and is not forwarded to Claude as native policy.

Only an actual new Claude initial input with a known committed sequence and
message may seed the new presentation lease. Bind its locally minted native
UUID to the exact query object, runtime, current turn object and independently
initialized primary native session. Missing sequence still permits the normal
legacy send, but supplies no initial-input retarget lease.

The lease alone owns the finite discriminator `usage.deliveryKind: "turn-start"`
on the existing reserved ambient processing receipt. Native frames, their
content, a caller's requested route or a queue ACK cannot mint this field.
Existing live-steer receipts omit the new field and keep their prior matching.

Publish only after the predecessor's exact primary lifecycle or explicit
reply/result UUID correlation witnesses consumption of that initial input.
Recheck the same live owner around awaits and synchronously consume the lease
beside one-shot event publication. Cancellation, discard, reset, replacement,
retirement and failed queue admission revoke only their exact lease; foreign,
child, malformed or unknown identities cannot confirm it. Keep the existing
finite bookkeeping and never reject, replay or silently drop a user's input
merely because presentation evidence cannot be retained.

## Exact renderer mapping and settlement

The consumed receipt itself is the durable mapping to the actual new turn; do
not introduce a separate acceptance ACK or an alias from every old turn to the
current one. The typed initial-input branch requires all of the following:

- An own-data, exact `turn-start` discriminator and explicit safe receipt
  intent sequence equal to the pending command's actual acknowledged sequence.
- The exact pending message identity and captured account, still matching the
  current Claude account.
- The receipt's actual nonempty activity turn identity; never select the
  session's current or latest turn as a substitute.
- A single exact runtime across the receipt's usage, its native-work owner and
  the current session. That runtime belongs to the backend's qualified native
  initial-input lease.

Only this stronger branch may map the pending row's preceding turn or query
runtime to the consumed new owner. A same-account new query must still supply
its own primary initialization and exact native consumption. Live-steer and
legacy branches retain captured turn/runtime equality. An absent discriminator
uses only the established legacy path; an unknown, inherited, accessor-backed
or malformed discriminator cannot gain either the stronger branch or a legacy
fallback. Missing or malformed sequence never gains retarget authority.

A command ACK binds the attempt; it does not prove consumption. If the native
receipt arrives first, retain it without clearing the row until that exact
acknowledged sequence is known. Reusing a saved message identity for another
explicit attempt cannot borrow an older receipt. No mapping-only activity,
queue acceptance, background count, timestamp, root completion or prose may
settle the shelf.

## Ordinary attachment-preparation admission

Separately recheck the ordinary steer's exact context, query, admitted turn
object and open stream after asynchronous attachment preparation, immediately
beside lifecycle/lease registration and its single queue offer. A stale owner
must cause zero native offers, without queueing first and then throwing or
charging bookkeeping to a replacement turn. This does not add the stronger
explicit-priority pending-frame fences to ordinary input. Preserve legitimate
ordinary deltas and the existing native priority behavior. Never retry a
possibly accepted message to repair presentation.

The existing Codex no-active-turn recovery can resubmit an input, so it also
requires the already admitted Codex driver and its typed `turn/steer` failure.
Across the authenticated daemon boundary, require the canonical RPC error tag
and the exact source-authored Codex method wrapper. Claude output, a generic
transport error or similar-looking diagnostic prose supplies no retry authority.

## Retention, privacy and verification

Use the existing bounded ambient lifecycle projection and renderer retention
path for the complete typed consumption receipt across background views, ACK
ordering and reconnect. Do not create an unbounded alias ledger or scan chat
history. Test actual durable retention and hydration beyond the ordinary tail;
a live-only mocked event is insufficient. Bounded omission and unknown legacy
observations remain unknown rather than being reconstructed from chat prose.

Retain only the existing content-free correlation identities, finite kind and
sequence. Keep the native UUID opaque in the reserved digest identity. Add no
prompt/output logging, credentials, provider paths, new probes, provider
authority or permission-mode changes. A presentation receipt cannot complete a
turn, cancel a task/callback, redirect a message or initiate inference.

Extend the existing adapter input/lifecycle owners, committed reactor boundary,
real retention/hydration owner and native composer journey. Require intended
failing-before/passing-after evidence for the late ready-to-start race and the
ordinary preparation fence. Cover same-query and new-query starts, a receipt
before ACK, reused-message attempts, foreign/child/retired input, mixed runtime
fields, unknown/accessor kinds and no-consumption acceptance. Keep every native
input, assertion, worker, deadline, sandbox and ownership boundary. Targeted
local checks do not substitute for the exact new hosted CI gate.

Publishing source or a rebuilt bundle does not prove adoption by the running
Debug app or its providers. This task does not authorize a restart, request
replay, old-receipt backfill or reinterpretation of the historical screenshot.

## Provider reference

The current [Claude Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#user_message_uuid)
and pinned SDK declarations define the native correlation boundary.
[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
remains the existing persistent queue; this decision adds no new native input
mode or native lifecycle semantics.
