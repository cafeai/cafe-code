# Decision: bounded, isolated public subagent history

Decision status: Accepted within the authorized history repair
Implementation status: Implemented; verification requirements and operational limits are below
Created: 2026-10-04 14:08:58 JST (UTC+0900)
Last updated: 2026-10-07 04:48:16 JST (UTC+0900)
Decision authority: implementation choice within the user's request to fix sparse/stale subagent detail and push dev
Supersedes: none; supplements existing lifecycle retention and immutable history ownership
Partially superseded by: [Codex history ancestry](codex-history-ancestry.md), which corrects the stored-thread session-ID interpretation while preserving this decision's other boundaries.
Supplemented by: [bounded child activity](provider-aware-composer-and-child-activity.md), which adds content-free operation categories without exposing the raw tool history excluded here.
Partially superseded by: [useful activity details](subagent-activity-details.md), which admits separately bounded sanitized file/command descriptions only; raw tool payloads, private output and all history-authorization boundaries remain unchanged.

## Context

Codex's summary-turn history contains the first user message and final assistant reply, not all commentary. An agent reused for new work can therefore display an older final alongside fresh command progress. The renderer previously hid a refresh failure after an initial success. Assistant reply completion also lacked a content-free lifecycle invalidation.

The behavior is demonstrated by the immutable [Codex summary-view regression](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/tests/suite/v2/thread_read.rs#L504-L556). Its [item-list implementation](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/src/request_processors/thread_processor.rs#L3432-L3511) offers pagination but no public-item filter. Reading full native items on the live connection could expose it to an oversized private command/result payload.

## Decision and alternatives

Keep ordinary thread hydration on bounded summaries. For public child detail, launch one scoped, read-only app-server through the existing configured instance and immutable per-turn root. Verify exact root/child metadata and ancestry before any item request. Do not resume, submit a turn, subscribe a parallel live stream, or infer ownership from paths.

Read newest-first item pages, immediately admitting only explicit user text and assistant messages, deduplicating native identities only inside the trusted reader, and restoring chronology. Bound native pages, item count, retained source public bytes, incoming line bytes before decoding, and total adapter duration. Canonical limits in `CodexSessionRuntime.ts` and `orchestration.ts` remain authoritative. The separate command scope ensures an oversized item retires only the history reader, not active generation; a semaphore limits each adapter to one reader.

An unexhausted native cursor or local scan budget sets `historyIncomplete`. Unknown missing message/byte counts are never fabricated into exact typed gaps. Shared canonicalization still enforces public message/text/encoded budgets and known head/tail omissions. This recent window may exclude the original assignment; the UI states that earlier history is outside the retrieval limit.

Optional canonical UTC item timestamps and assistant phase identify dated updates and final replies without exposing native turn/item IDs. A previous final remains labelled “Final reply” even while the child is active; timestamps are display provenance, not proof of current liveness. Public reply completion creates a generic “Posted an update” progress edge, not a copy of message text.

Retain the last safe same-identity transcript after refresh failure, visibly mark unavailable updates, and offer Retry through the same bounded refresh coalescer. Child/turn/history identity changes clear prior content. Lifecycle revisions, visibility catch-up, single-flight/trailing refresh and scroll-follow behavior remain; no blind polling is introduced.

Rejected alternatives are whole-thread full hydration, native rollout-file interpretation, live-channel full item pages, and timers that infer state from prose or inactivity. They respectively weaken resource bounds, duplicate provider parsing, jeopardize active transport, or lose provider authority.

## Security, compatibility and failure consequences

Durable exact child/root/account authorization is unchanged. Both authenticated RPC boundaries use the same byte-exact bounded child/history validator; neither trims opaque identities. Only reconstructed allowlisted text, phase, timestamps and cutoff indicators cross DTOs. Reasoning, hidden messages, private tools, paths, provider errors and raw fields stay excluded. Explicit no-op protocol logging on the isolated client also suppresses decode-failure causes, which can contain malformed private payloads.

Provider errors, unsupported item APIs, oversized wire items and deadlines fail the refresh with finite redacted errors and visible Retry. A successful finite scan is not a guarantee that native indexed storage already contains every in-memory update. Full tool history is intentionally not displayed. No additional inference is used.

Fields are optional for older adapters/daemons; coordinated backend/renderer deployment is required for the new display. No database migration, dependency update, provider authentication change or platform-specific launch behavior is introduced. Existing Windows/macOS/Linux command policies are retained.

## Provider naming audit and correction

The user's follow-up asks whether a newly spawned child receives a visible fresh title on both providers. Cafe displays provider-authored task/thread names and bounded metadata fallbacks; it does not call a title model for each child or promise globally unique names. The exact child identity, not its title, separates roster entries.

Codex native thread names and rename notifications take precedence over a task-path leaf or nickname/role. Ordinary activity repeating the original path must not undo a native rename. A concrete assignment start with a changed path may establish a new fallback name for reused work; an explicit null native rename clears the title back to bounded fallback metadata. Naming provenance is private, bounded inside the existing per-runtime child LRU, and generation-bound independently of mutable liveness observations. A foreign status event cannot authorize a foreign rename, including when it arrives first. This changes neither terminal state nor timing/history authorization.

Claude task descriptions establish the visible title. Retry diagnostics belong in progress text, not in the title. An assistant-first recovery may provide useful child metadata before its authoritative task lifecycle arrives; that recovery description cannot supersede a later task description. Explicit SDK parent-tool identity is structured evidence of nested output, not prose-derived liveness or a guessed transcript identity. Provisional tool/task correlation must be retired on an exact authoritative binding without inventing a completed, failed, or stopped result. Private naming/correlation provenance never enters public presentation fields.

Regression qualification includes native title/path precedence, rename followed by stale-path progress/control completion, nullable title clears, reused assignment names, sibling isolation and foreign-generation sequences. Claude tests cover stable retry titles, assistant-first recovery followed by independent task identity, and stale recovery descriptions after a native title. Shared roster tests verify exact-row label replacement/restart and retraction while preserving existing clocks and liveness overlay.

## Verification and operational limits

Synthetic runtime tests cover root/tree admission before item reads, private filtering, commentary/final retrieval, timestamps, pagination/cutoff/duplicate bounds, transport isolation and failure. Adapter tests cover isolated live-root reads and content-free assistant invalidation. Service/contracts tests preserve safe metadata while rejecting invalid dates, phases, inconsistent truncation and mutated opaque identities. Browser tests cover prior final plus current commentary, timestamp display, incomplete history, failed same-child refresh, Retry, selection isolation and scroll behavior.

Replay using the pinned Node/Corepack Yarn toolchain: run relevant `@cafeai/cafe-code` provider-layer tests, `@cafecode/contracts` tests, and `@cafecode/web test:browser src/components/chat/MessagesTimeline.browser.tsx`, followed by repository `fmt`, `lint`, `typecheck`, `test`, and final `build:desktop --force`. CI must qualify the exact pushed revision on all native hosts. Local synthetic tests do not claim a running old daemon has adopted the change; normal application restart applies the rebuilt bundle.
