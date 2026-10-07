# Decision: separate native history wire budgets from public display limits

Decision status: Accepted within the authorized subagent-history repair
Implementation status: Implemented; focused transport/privacy/UI qualification passes, and full release gates remain required
Created: 2026-10-07 10:15:38 JST (UTC+0900)
Last updated: 2026-10-07 10:33:50 JST (UTC+0900)
Decision authority: implementation choice within the user's request to investigate missing child histories, fix confirmed problems and push dev
Partially supersedes: [bounded public subagent history](subagent-public-history.md), specifically its 1 MiB native item-response budget and all-or-nothing behavior for local size exhaustion. Ancestry, account, privacy and live-session isolation remain unchanged.

## Context and alternatives

The native `thread/items/list` API serializes private command output before Cafe can project public messages and safe activity details. Read-only diagnostics established repeated incoming-line-limit errors while other child reads succeeded. The 1 MiB public-history transport cap therefore rejected valid native pages even though the displayed projection was small. It was not evidence that the agents stopped working or that the whole-request deadline expired.

Smaller item pages alone cannot admit one large private item. Unbounded responses, reading full history on the live connection, parsing native rollout files and disabling validation are rejected. A custom streaming JSON projector could discard output before buffering, but would introduce a new JSON grammar/schema security boundary without evidence justifying that complexity. Merely increasing the line cap would still lose all safely retrieved pages at the next limit.

## Decision

Keep the existing separate, scoped read-only app-server and exact immutable account/root/child authorization. Verify metadata ancestry before history reads. Distinguish **native wire allowance** from **public retention**:

- Primary isolated reader: 16 MiB per JSONL line and 32 MiB cumulative raw input per process scope. The latter includes initialization, ancestry metadata, notifications, malformed bytes, whitespace and delimiters. Reject an over-budget input chunk before decoding or protocol logging. This is a finite policy allowance, not a measured maximum of native output.
- Existing item/page/cursor limits, 2 MiB source-public-text allowance, public message/activity DTO limits and explicit no-op isolated logger remain in force. No private output or raw errors become displayable because the wire budget is larger.
- Only a typed local line/aggregate-size failure **during item-page reading after ancestry proof** becomes an explicit cutoff. Retain already projected public messages/activities, set both incomplete flags, and stop reading. Schema, metadata, ancestry, request, process and timeout failures remain failures.
- If that size cutoff left no useful public data, retire the original process scope before at most one fresh summary-only reader. Reinitialize and reverify the same exact ancestry. Request only descending `thread/turns/list` with `itemsView: "summary"`, at most 16 turns in small pages. Its independent bounds are 1 MiB per line and 4 MiB total raw input. Project only user/assistant text; never trust the endpoint's requested view as permission to retain raw variants. Both incomplete flags are true even if a summary page is exhausted: native summaries omit intermediate commentary and activity.
- A fallback-local history size cutoff retains useful safely projected messages with explicit incompleteness. If none survive, the read fails with a finite redacted error and the UI keeps its saved task summary/previous safe snapshot and Retry. It does not trigger another reader. Failures before ancestry verification do not grant access to even a partial history.

The existing adapter semaphore and 15-second whole-request deadline encompass both sequential scopes, including preparation and retirement. Neither is reset for fallback. Total admitted raw input is at most 36 MiB across the two scopes; up to one rejected buffer per attempted scope may already have been delivered by the process abstraction, and stream/OS buffering is separate. Per-scope retained line strings stay bounded before concatenation; parsed JavaScript object overhead is additional, not falsely claimed to equal raw byte size. Public retained data has its separate tighter limits. Canonical constants in `CodexSessionRuntime.ts` are authoritative.

The generic protocol's cumulative option is opt-in: ordinary long-lived clients keep their existing 64 MiB per-line policy without a lifetime byte allowance. An explicitly invalid cumulative option fails closed to a one-byte allowance instead of disabling the guard. Protocol termination retains its finite error for requests submitted between pages or while outgoing logging awaits; a closed queue must not create a deferred that waits forever. No provider request is replayed.

## Security and compatibility

Only the existing typed public projection crosses daemon/browser boundaries. Exact response IDs, native spawn-parent chain, original account/home/root binding, immutable child tuple, opaque cursor validation, redaction and display sanitization remain unchanged. The fallback is a new read-only process, never a live-client reuse, `thread/resume`, `thread/start`, `turn/start`, paid inference, profile edit or database repair. Normal backend adoption is necessary; a source change does not repair a running old daemon.

The UI uses its existing incomplete-history notice; it must not imply that a summary contains every operation or that an empty bounded result means the agent did no work. Refresh failures unrelated to size retain the previous same-identity safe snapshot and Retry. Native indexed history may lag in-memory updates.

This changes no dependency, database schema, native launch policy, account permission, provider profile or platform-specific behavior. All hosts use the same opt-in byte checks and existing scoped subprocess ownership.

Cutoff traces contain fixed read-mode/budget-kind/outcome labels, retained message/activity counts and a fallback-requested flag only. They must not include native identities, cursor text, paths, commands, payloads or public message content. Useful-data admission uses the same visible-text measurement as public canonicalization, so control/bidi-only source text cannot suppress recovery while leaving the UI blank.

The adapter wraps the whole untrusted history operation—including preparation and scope finalizers—in a tracing-disabled boundary. A no-op protocol logger alone cannot protect failure spans: native request/schema exceptions may contain private response text. The safe outer span receives only the existing reconstructed finite error or an annotation-free interruption and explicitly collected fixed diagnostics. A received interruption keeps its named or anonymous identity while private annotations and companion defects are dropped. If the underlying Effect scope instead replaces the body exit with a cleanup defect, that defect becomes a finite failure; the boundary does not invent a missing interruption. This is confined to history reads; it does not disable global tracing or diagnostics for unrelated provider work.

## Verification

Synthetic tests exercise the actual command-layer client/JSONL decoder with a single private output larger than the former 1 MiB cap, exact public neighbors and activity, split Unicode and hostile-looking escaped output. Assert no private output appears in projected data or diagnostic logs. Qualify primary/summary line and aggregate cutoffs, chronology, partial retention, one-time fallback after scope retirement, ancestry drift, no fallback for non-size failures, and no third process.

Protocol tests cover exact raw-byte acceptance, split and invalid UTF-8, whitespace, invalid option admission, finite error privacy, budget exhaustion between requests and termination during held outgoing logging. Existing generic line-limit and native command/process fixtures remain intact.

Capture spans through the production trace serializer as well as the ordinary Logger. Assert that synthetic private sentinels from request/schema failures, defects and cancellation companions are absent while safe outer outcomes/cutoff metadata remain available.

Replay with the pinned Node/Corepack Yarn toolchain: `yarn workspace effect-codex-app-server test src/protocol.test.ts src/client.test.ts`; `yarn workspace @cafeai/cafe-code test src/provider/Layers/CodexSubagentHistoryTransport.test.ts src/provider/Layers/CodexSessionRuntime.test.ts src/provider/Layers/CodexAdapter.test.ts`; then repository formatting, lint, typecheck, full default tests and final `yarn build:desktop --force`. Hosted CI must qualify the exact pushed source on Linux, macOS and Windows. Synthetic evidence does not claim live session adoption.
