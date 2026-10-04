# Decision: prove Codex history ownership through parent ancestry

Decision status: Accepted as an implementation choice within the user's request to repair unavailable subagent history.
Created: 2026-10-04 21:15:26 JST (UTC+0900)
Last updated: 2026-10-04 21:28:31 JST (UTC+0900)
Implementation status: implemented; 281 focused runtime/adapter tests and server typecheck passed. Integrated and hosted release requirements are below.
Supersedes: the session-ID interpretation of tree admission in [bounded public subagent history](subagent-public-history.md). All other isolation, authorization, retention and privacy requirements remain in force.

## Evidence and cause

Read-only Cafe diagnostics showed repeated `session-tree-mismatch` failures in hundreds of milliseconds, rather than a timeout or an oversized history response. The immutable [Codex stored-thread conversion](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/src/request_processors/thread_processor.rs#L5801-L5808) sets the response's session ID to that individual thread's ID. A live loaded-thread view can replace it with shared session metadata. Cafe deliberately uses an isolated reader that does not load or resume these threads, so comparing root and child session IDs rejects legitimate persisted children.

The failure does not demonstrate missing provider history, dead agents or a long-running-session limit. Increasing timeouts, loading the thread into the live provider, or accepting all children with a matching session ID would not correctly repair ownership validation.

## Decision

After the existing durable Cafe thread/turn/child/history/account binding authorizes the request, read exact root and child metadata through the scoped isolated client. Walk the child's provider-reported parent chain to the immutable authorized root. Each requested ancestor must return its exact ID, explicit subagent-spawn source, and a consistent parent in both native metadata representations. Reject cycles, self-reference, missing or inconsistent metadata, unrelated roots and excessive depth. Even matching session IDs do not override conflicting parent ancestry.

Read no transcript items until the entire chain reaches that root. Ancestor requests are metadata-only, sequential and bounded by the canonical ancestry limit in `CodexSessionRuntime.ts` and the existing whole-request deadline. The existing incoming-line, item/page/public-byte budgets, semaphore and redacted error behavior remain unchanged. No new native subscriptions, resume calls, inference, provider configuration edits or persistence migrations are introduced.

## Security and compatibility consequences

This corrects the ownership evidence, rather than removing an authorization check. Titles, paths, session-ID coincidence and user-supplied ancestry remain insufficient. Parent metadata is supplied by the already-authorized configured provider; Cafe does not interpret private rollout files or infer lineage from storage paths.

Claude and Grok history behavior and the shared renderer are unchanged. Extremely deep or incomplete native chains remain unavailable with a bounded retryable error; the UI must not imply that an unavailable read means an empty transcript. Ordinary thread hydration remains summary-only. A rebuilt backend/daemon is necessary to adopt the fix; the implementation does not interrupt existing sessions to force deployment.

## Verification and replay

Runtime fixtures must reproduce distinct per-thread stored session IDs and verify direct and nested child retrieval. Negative cases cover a shared session ID with unrelated ancestry, forged response IDs, missing or conflicting source parents, cycles, self-reference and the depth bound. Assert that rejected ancestry performs no item read, and retain public-only filtering, pagination and transport isolation coverage.

Use the pinned Node/Corepack Yarn toolchain to run the `CodexSessionRuntime` and `CodexAdapter` suites, then repository formatting, lint, typecheck, default/browser tests and the final forced desktop build. Hosted verification must use the exact pushed revision. Synthetic tests and read-only diagnostics do not claim a running older daemon has adopted the new code.
