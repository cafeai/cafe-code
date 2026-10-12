# Provider stream reconciliation

Last updated: 2026-10-11 01:53:21 JST (UTC+0900)

## Ownership and exact text

Provider adapters normalize upstream events into canonical item identities and append-only text deltas. `ProviderRuntimeIngestion` coalesces small deltas before durable orchestration writes. `ProjectionPipeline` persists the message and keeps terminal turn lifecycle separate from late content reconciliation. The renderer displays the projected text; it must not guess that a short word is invalid or remove it heuristically.

Ingestion commits every observed UTF-16 code unit with a fixed-memory SHA-256 commitment. An authoritative completed item may replace lagging projected text only when it contains that exact committed prefix, or no stream was observed. It flushes its own buffered tail, never derives a suffix from an asynchronously lagging SQL row. Different text and shorter completions fail closed. Completion remains a content boundary, not permission to reopen a stopped turn or change a newer turn's state.

Codex `item/agentMessage/delta` and `item/completed` must preserve identical source text. `CodexAdapter.itemDetail` may check whether an `agentMessage` is blank, but must not trim a nonblank message. One removed trailing newline is enough to invalidate an otherwise complete stream commitment. In the observed failure, the native completion matched all streamed text; trimming caused the final replacement to be rejected, leaving an older terminal message with only its first projected chunk. The fix preserves source whitespace rather than weakening the commitment or hiding short output.

That invariant also applies after the adapter. The shared `ItemLifecyclePayload.detail` schema validates nonblank source without transforming it in **either encode or decode**. The persistent daemon journal, live publication, replay and remote event-record JSON codecs all reuse this contract. A trim transformation there previously removed valid final newlines even though the adapter and raw native payload preserved them. It could also hide a leading-space divergence from the integrity guard. Normalized titles and identifiers retain their existing trimming rules; source text does not. Empty or whitespace-only detail is still invalid, now including encode-side publication.

Source: [official Codex app-server item lifecycle](https://learn.chatgpt.com/docs/app-server#items). The exact-prefix guard is Cafe's persistence integrity boundary, not an upstream claim.

## Resume history must not complete newer work

Provider ingestion and accepted user starts use different asynchronous lanes. Checking a thread before dispatching its session update is insufficient: a new turn ACK can arrive between that read and serialized command admission. A completed turn from a resume snapshot could then set the session to ready with no active turn, accidentally closing the newly accepted turn while its output continued streaming.

Terminal, idle, startup-settlement, goal-settlement and runtime-error observations now include a server-only `expectedSessionLifecycle` tuple. The decider compares that tuple against the current lifecycle under serialized admission. If a newer lifecycle won, the old mutation receives a fixed benign rejection; ingestion still processes its scoped content and receipt. Only heartbeat clock changes for the same concrete active turn are tolerated, so real completions are not discarded just because a heartbeat ran. This internal admission guard is not persisted in public events or accepted from renderer commands.

The comparison canonicalizes an omitted or explicitly null `subagentRuntimeId`
to the same absent-generation value on **both** the captured guard and current
session. SQL hydration omits a NULL runtime ID, while an in-memory session can
retain an explicit null after provider binding. Comparing those representations
literally previously rejected a genuine Grok completion as superseded, leaving
the completed chat displayed as running. Concrete generation IDs, provider,
account, turn, status, and provisional-session timestamps remain strict fences.
An absent session is still distinct from a session without generation evidence.
This normalization applies only to the internal comparison tuple: omission in a
session update still means preserve existing evidence, while null clears it.

The correction prevents false rejection of newly processed observations. A
completion already recorded as rejected remains an immutable command receipt;
replaying that command does not repair it. Normal startup reconciliation can
clear orphaned running state only after checking provider ownership and active
turns, and may classify it as interrupted rather than reconstructing completion.
Do not delete receipts, reset replay cursors, resend the prompt, or infer success
from a final-looking assistant message to repair historical state.

Already-terminal historical starts/completions cannot consume a newer pending start. An exact indexed turn lookup supplies that fact without a transcript scan. Session-ready initialization metadata cannot clear a concrete active turn. Positive provider starts and independently verified ownership recovery keep their existing authority; generic output and historical replay do not gain authority to reopen terminal work, bypass Stop, or restart providers.

This prevents future stale lifecycle mutations. It does not rewrite an already-damaged session, repair arbitrary historical state, or promise that every current native process is alive. Current live state must be verified independently before any recovery.

## Subagent ordering and native ownership

Retained lifecycle and current observation are separate. The originating native
context stamps a random generation identity onto its session and child events;
orchestration persists current evidence and rejects stale-generation session
mutation. Same-runtime daemon adoption preserves the identity. Native replacement
does not. Missing/mismatched generation or a stopped/error session leaves saved
nonterminal workers **Status unavailable**, preserving history without claiming
completion or continuing their timers. The renderer's own WebSocket connection
is not the native runtime boundary. See [runtime-bound observation](decisions/subagent-runtime-observation.md)
for legacy behavior, authority and verification requirements.

A failed Codex root is not necessarily an unavailable native context. Fresh
owner-authored terminal evidence plus exact live inventory can retain that
context's ready state and children while the root remains failed with its error.
Ingestion commits error first, then ready through a second exact lifecycle CAS;
it never makes the failed root successful or reopens it. Only definitive
allowlisted transient failures permit a server-fenced short continuation, with
capped jittered backoff and no fixed retry cutoff. Native warnings do not spawn
nested retries. Stop and newer input win; uncertain acceptance is never resent.
If a continuation fails before its started event, retain its exact pending input
until a matching immutable attempt/ACK receipt and fresh same-owner proof permit
an internal atomic failed-turn association. Do not invent a running state or
erase observed execution timestamps; newer controls still veto the association.
See [the persistent recovery decision](decisions/codex-persistent-transient-recovery.md).

Remote compaction has its own finite native retry loop. Codex 0.162.1 wraps its
exhausted stream error in the exact `Error running remote compact task: ` prefix
while retaining `codexErrorInfo: other`. Cafe recognizes that single anchored
wrapper around the already qualified UUID-bearing processing error. Arbitrary
nested prefixes, prose, contradictory details and permanent error variants remain
non-retryable. The final failed turn releases its tracked automatic-compaction
items even without an item completion, allowing fresh native owner proof to
qualify continuation; manual or uncertain compaction still vetoes admission.
The compact notice leads with **Reconnecting** or **Agents running**, not a claim
that the whole chat stopped. The root's terminal error stays in the work log.

Native reconnect counters are observations, not Cafe submissions: show cumulative
deduplicated native warnings per exact runtime/target/turn without recycling the
provider's prose fractions or inventing its unreported timer. Cafe continuation
ordinals are durable accepted-chain metadata independent of delay saturation;
legacy saturated counts and tracking ceilings remain explicit lower bounds.
Only Cafe's bounded actual sleep deadline produces a live countdown. One latest
exact-owned current-turn recovery marker survives the ordinary activity tail on
both snapshot rehydration and live renderer pruning. Cancellation, uncertain ACK
and attempted submission end older countdowns without claiming a running/accepted
root. Recovery display and failed-root child observations never retimestamp the
terminal root, in either the projection or renderer.
Qualified terminal child errors retain failed status and bounded detail in the
child task without emitting a redundant parent-clock warning. Missing child
identity retains a diagnostic fallback; it does not invent child ownership.

Codex can send an unscoped `thread/status/changed: systemError`, followed by a
root-scoped nonretrying `error`, immediately before the definitive failed
`turn/completed`. Keep the concrete root identity through those preliminary
notifications: neither diagnostic establishes process death or a terminal
timestamp. The definitive completion closes the root with its actual failure
detail and time before fresh exact owner inventory may publish ready context.
A late unscoped thread error cannot demote that already verified failed-root
context when the same account, generation, root and immutable failure time still
match fresh inventory. Missing/uncertain inventory retains conservative handling.
An exact current-generation unscoped native thread-watch diagnostic also cannot
consume a newer pending input. Suppress its lifecycle write entirely, preserving
the manual `starting` or automatic-recovery `ready` tuple as observed. Read pending
input freshly after any awaited inventory observation; this protection does not
grant readiness or retry authority.
Repeat the no-pending refusal under serialized engine admission: an automatic
intent may commit after that read without changing the session's lifecycle tuple.
This internal command guard is not client-controllable or copied into events.

The native boundary also rejects availability during pending compaction, sticky
history uncertainty or context closure. Stop, newer root/start and control fences
remain governing; preserving an active identity does not invent a new running
turn or authorize inference. Existing failed/null historical tuples are not
automatically retimestamped or repaired. Normal rebuilt backend/daemon adoption
and a deliberate subsequent turn are required for an already stranded session.

A subagent's restart and a metadata refresh for its previous completed run can
arrive in the same millisecond. Timestamp plus opaque UUID sorting is not their
order. The SQL activity projection, in-memory event projector, and live renderer
use the enclosing durable orchestration sequence for every activity append.
Provider-local counters can reset on resume and must not override that order.
This preserves the explicit new start after old terminal metadata on both live
delivery and reconnect, without using elapsed time to guess that an agent is
working. See [subagent activity surfaces](subagent-concurrency.md#activity-surfaces).

Within an exact Codex runtime/root/account, a child's first initiating visible
turn remains its owner. A later root turn messaging, waiting on, or resuming that
child does not create a second row under a different parent. V2 activity follows
that owner; legacy multi-receiver control envelopes are partitioned by receiver
owner within the existing total receiver ceiling, with no duplicate ordinary
Work Log entries. Historical transcript authorization remains turn-qualified.

Except for an explicit new native start, child notifications carrying a concrete
native turn must match the child's known native turn before they can change
routing, aggregate liveness or canonical UI status. The same fence applies
to official parent completion activity that carries the native child turn in
its item identity. A delayed old tool event cannot replace an already-active
native turn identity and make a following stale completion appear current.
Explicit native starts can reopen reused children; metadata alone cannot.

The [official app-server lifecycle](https://learn.chatgpt.com/docs/app-server)
separates item completion from turn completion. The implementation additionally
uses the pinned native Codex multi-agent source to interpret child activity;
MCP-server startup is not a subagent lifecycle event. These corrections require
no inference calls, provider restart, or changes to platform launch behavior.

## Claude block snapshots and compatibility

The [official Claude streaming flow](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow) emits an `assistant` snapshot for one completed content block before `content_block_stop`. Multiple snapshots may share the API `message.id`; each wrapper UUID identifies its own frame. A later model response can reuse block index zero within the same long-running Cafe turn.

`ClaudeAdapter` tracks those identities separately. It matches a snapshot to one unmatched block in the native message, verifies the exact streamed prefix, and appends only a missing suffix under that block's existing canonical item id. A no-delta block uses its full snapshot. Ambiguous or nonmatching snapshots cannot overwrite another block. Delayed snapshots of already-closed blocks are recognized without duplicating a message. Nested subagent streams remain isolated from primary assistant text.

Stream commitments retain fixed-size hash state, not another copy of every streamed paragraph. Completed blocks leave the result-drain list and release full snapshot text. Unmatched snapshot correlation and wrapper replay keys use the existing bounded Claude message limit; reset them at the response-segment boundary. Identity commitments preserve exact UTF-16 code units, including malformed surrogate units that would otherwise collapse during UTF-8 conversion. Warnings contain fixed explanations and counts, not provider text.

The compatibility review compared installed/runtime protocol behavior and current official releases. At the stream-fix audit timestamp, [Codex's changelog](https://learn.chatgpt.com/docs/changelog) targeted CLI/app-server 0.153.4; the subsequent [0.154 capability update](codex-154-compatibility.md) records the newer audit without changing these stream-integrity requirements. The initial Claude stream correction retained SDK 0.3.260 while the newest releases were quarantined. The subsequent [0.3.266 compatibility update](claude-266-compatibility.md) moves all three pins after the package-age audit and adds correlation regressions; it does not replace the local query transport. A newer explicitly configured system CLI remains authoritative; matching wrapper and CLI version numbers is not itself a compatibility requirement.

## Diagnostics and historical data

When a restored client repeatedly reconnects, distinguish the responsive
desktop debug endpoint from backend liveness. The compact connection history
records socket attempts and closes; desktop trace spans show watchdog restarts.
A main-thread sample inside synchronous SQLite, combined with an unfinished
detail load, warrants inspecting the exact query plan rather than extending
timeouts. The opt-in `CAFE_CODE_SQL_STATEMENT_DIAGNOSTICS=1` diagnostic records
statement-start fingerprints, operation classes, parameter counts, and slow
completion times before/after native execution. It does not log SQL text,
parameter values, or transcript content. Enable it only for a diagnostic launch
and disable it afterward; a successful build alone does not restart the client.

Each newly accepted user turn also retains a bounded [configuration sanity check](decisions/turn-configuration-work-log.md) in authenticated work-log activity. Its model, effort/Fast settings and configured account label are frozen at submission, rather than read from the current composer when history renders. Missing native overrides remain provider-default/unknown; the record is not independent backend-model or billing telemetry. The display adds no provider queries, inference or lifecycle authority, and old turns are not retrospectively guessed or rewritten.

A rejected nonempty completed item emits `provider.assistantCompletion/textMismatch` at completion, not per token. Fields are restricted to provider kind, the fixed reason `completion-shorter-than-stream` or `completion-prefix-mismatch`, and `streamedCodeUnits`/`completionCodeUnits`. Consuming the stream commitment and normal canonical event deduplication prevent repeated warnings from the same completion. No prompt, output, digest, account, conversation identity, credential or filesystem path is logged by this diagnostic.

The fix affects newly handled provider events. It does not rewrite historical rows on startup, replay all provider history, or restart live providers. Previously stranded text remains unchanged unless the user explicitly chooses **Attempt repair from provider history** in the thread's sidebar context menu while debug mode is enabled. That bounded, authenticated service independently validates terminal message ownership and prefix-safe repair from retained journal or configured provider history; recovery depends on the source data still being available.

The shared-codec correction requires normal rebuilt backend **and daemon** adoption; an already-running generation is not live-updated by a build or push. It cannot reconstruct whitespace already removed from old canonical journal detail. The retained raw payload may still contain the original, but this change grants no new raw-payload repair authority and performs no historical write. Existing explicit repair remains subject to its own retained-source and prefix checks.

## Verification

Use the repository-pinned Node runtime and Yarn through Corepack, with the checked-in lockfile and setup. The stream correction itself requires no dependency change; the accompanying Claude compatibility update deliberately changes the SDK pin. These regressions do not require credentials, network access or live provider binaries.

- `corepack yarn workspace @cafecode/contracts test src/providerRuntime.test.ts`: independent lifecycle/event JSON encode and decode, exact leading/trailing whitespace, CRLF and surrogate code units across every provider kind, blank rejection and unchanged title/identifier normalization.
- `corepack yarn workspace @cafeai/cafe-code test --config vitest.config.ts src/providerDaemon/EventJournal.test.ts`: persistent journal publication, live subscription, fresh journal replay and independent event-record JSON codecs preserve the same exact source.
- `corepack yarn workspace @cafeai/cafe-code test --config vitest.config.ts src/provider/Layers/CodexAdapter.test.ts`: exact leading/trailing whitespace, CRLF, whitespace-only suppression and strict streamed-prefix compatibility.
- `corepack yarn workspace @cafeai/cafe-code test --config vitest.config.ts src/provider/Layers/ClaudeAdapter.test.ts`: multiple block snapshots sharing an API message id, reused block indexes, duplicate wrappers, partial/no-delta repair, split surrogates and cross-message/prefix rejection.
- `corepack yarn workspace @cafeai/cafe-code test --config vitest.config.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`: late old-turn exact completion crosses the real shared JSON codec and restores full text without disturbing a newer active turn or timestamps; replay is idempotent, leading-space and other mismatches retain streamed text and diagnostics remain content-free.
- `corepack yarn workspace @cafeai/cafe-code test --config vitest.config.ts src/orchestration/sessionLifecycle.test.ts src/orchestration/decider.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`: absent/null runtime-ID normalization across SQL hydration and in-memory admission, stale observations racing accepted new turns, historical resume start/completion, readiness while active, genuine completion across heartbeat-only changes, and exact rejection behavior on replay.
- Run `yarn fmt`, `yarn lint`, `yarn typecheck`, and `yarn test`, followed by `yarn build:desktop --force` after tests. A successful build does not replace the already-running desktop/daemon processes; applying it requires the normal app restart lifecycle.

The stream-content corrections stay within the existing adapter/ingestion/projection contracts and add no persistence migration or new repair authority. The separate subagent retention correction adds schema-only migration 82 and bounded per-thread legacy hydration, as documented in the [retention decision](decisions/subagent-lifecycle-retention.md). Neither change adds public protocol or provider inference.
