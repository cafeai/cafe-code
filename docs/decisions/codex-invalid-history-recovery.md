# Decision: confirmed invalid Codex history admission and explicit recovery

Status: Accepted; implementation is qualified with isolated fixtures, not paid provider calls.
Last updated: 2026-10-07 03:28:32 JST (UTC+0900)

## Problem and upstream boundary

Codex can persist a malformed, oversized model-generated function call. A subsequent API request can reject the saved call's `input[n].arguments`, even when the current user message is small. Later attempts may surface only `Bad Request`. Restarting does not remove persisted native context, and native fork or compaction is not a guaranteed repair.

The reviewed stable Codex 0.160.1 source is pinned to [d27764b82f7118f674371e6d6e76271d9d606edb](https://github.com/openai/codex/tree/d27764b82f7118f674371e6d6e76271d9d606edb). In `codex-rs/core/src/stream_events_utils.rs`, completed response items are recorded before tool invocation. Tool hooks affect invocation, not already-recorded history. `context_manager/history.rs` truncates tool outputs, not function arguments; ordinary input normalization does not cap those arguments. Public app-server configuration exposes no supported interception hook that lets Cafe safely remove them before persistence. Model instructions, output budgets and scheduled compaction therefore cannot honestly guarantee prevention. No custom CLI, provider HTTP proxy, raw-event subscription or model-quality reduction is introduced.

## Decision

Cafe recognizes only a bounded structured provider failure with all three fields: `type=invalid_request_error`, `code=string_above_max_length`, and `param=input[n].arguments`. Generic HTTP 400s, arbitrary model prose, tool output and other oversized fields cannot create the guard. Runtime evidence must match the exact current native root and turn; a late child or superseded turn does not authorize blocking its parent or replacement.

The local fence is installed before asynchronous persistence. A small durable SQLite row binds the Cafe chat, configured provider instance and native thread, retaining only a fixed reason and time. Missing or unreadable persistence fails closed. The table deliberately does not depend on volatile runtime rows or orchestration projections, because a provider daemon can own a separate database. Hard-delete tombstones reject late inserts/updates; explicit daemon purge removes the exact chat's rows.

Before a start acknowledgement, evidence is held in a bounded set of candidate turn IDs and admitted only against the exact acknowledged turn. Overflow triggers one bounded native snapshot read for that root/turn. Inconclusive evidence fences future mutations only within the current runtime and emits a nonterminal warning; it does not invent a durable diagnosis or report an already accepted send as rejected. A concurrent confirmed diagnosis takes precedence. Accepted work retains its lifecycle ownership until a real terminal event.

Known-invalid native context cannot be resumed or submitted again through send, steer, native review, compaction, fork or goal activation. A fixed, content-free explanation replaces the confirmed error and subsequent generic errors without changing lifecycle identities. Reading saved Cafe context and stopping existing work remain available. There is no timeout-based clearing, implicit reset, native history mutation or automatic prompt replay.

This contains repeated failures **after positive provider evidence**. It cannot prevent Codex from generating the initial malformed call or diagnose every generic `Bad Request`. It is not an upstream repair and does not claim live provider qualification.

## Explicit owner recovery

The error banner offers **Continue in new chat**, gated by a confirmation. It uses Cafe's `thread.duplicate`, never native `thread.fork`: the original chat, native context and files remain unchanged. The copy has no native resume cursor, approvals, pending provider callbacks or active goal. Project copies retain their project association; standalone copies use a new empty private workspace and do not copy files. The owner's original draft is not submitted or transferred implicitly.

An explicit duplicate event creates a small projection-owned bootstrap admission. Before its first accepted native turn, the next owner message includes recent Cafe-visible conversation text using the existing bounded continuation composer: at most 40,000 transcript characters and the overall provider input limit, with explicit omission/truncation notices inside an included transcript. The current request and configured system prompt take priority: if fewer than 500 characters remain for history, no transcript or extra notice is injected. Earlier attachments are named, not silently re-uploaded; hidden reasoning, native tool history and other invisible context are not copied into the request. Users may need to restate missing context or attach needed files.

Idle session creation, failed startup and backend restart do not consume that admission. A running native turn or an internal content-free accepted-send fact does; subsequent turns use ordinary provider continuation. The accepted fact is replayable and handles completion arriving before the start acknowledgement without reopening or extending terminal work. Before that first context-bearing message, native review, goal setting and manual compaction are refused with an explanation: those operations can start a native turn without delivering the ordinary input transcript. Native fork is also refused while bootstrap is pending, before any workspace allocation or provider call, because a native fork would omit the still-undelivered Cafe context. They never authorize a hidden substitute message. Native forks do not acquire this marker. The renderer captures exact source chat/account/runtime, selected environment, route and mounted action owner; stale confirmation or completion cannot retarget a different chat. An uncertain duplicate acknowledgement retains the same command and target identity for explicit retry while the action owner remains mounted, rather than silently creating another chat. If that owner is gone, check the chat list before a new recovery attempt.

## Alternatives and operational consequences

- Automatically editing provider-owned rollouts is rejected: paginated history has native SQLite byte-offset/ordinal indexes and cross-process writer locks. Deleting JSONL lines can corrupt otherwise-valid indexing; tool/result pairing alone is insufficient authority.
- Native revert can discard a whole turn suffix and Cafe's existing revert can also restore workspace checkpoints. Neither is silently repurposed as recovery.
- A verified exceptional offline repair requires fresh, explicit authority, exact chat/account/file identity, independently verified full backup, native writer exclusion, valid native event semantics and preservation or reconciliation of all index references. This product change does not ship or invoke such a repair tool.
- Guard metadata contains no prompt, tool arguments, credential or native path. New diagnostics must remain content-free. Provider permission policy and theme colors are unchanged.

## Verification

Tests must cover strict positive/negative error classification, oversized diagnostic bounds, local-before-durable ordering, storage uncertainty, SQLite close/reopen, exact account/chat/native identity separation, child/stale turn rejection, notification/ACK ordering, every native admission gate, and hard-delete purge/tombstone behavior. Browser fixtures cover explicit confirmation, cancellation, exact duplicate wire identity, no automatic inference, stale route/environment/runtime completion, uncertain acknowledgements and unchanged ordinary errors. Provider-reactor fixtures qualify bounded duplicate context across Codex, Claude and Grok, first-send failures and one-time consumption. Full formatting, lint, typecheck, default and browser tests precede the final forced desktop build and exact-source hosted checks.
