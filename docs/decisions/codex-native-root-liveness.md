# Decision: native root availability is distinct from aggregate child activity

Decision status: Accepted within the authorized steering bug fix
Implementation status: Implemented; deterministic runtime, queue, admission and browser regressions verified
Created: 2026-09-23 20:08:11 JST (UTC+0900)
Last updated: 2026-09-23 20:51:26 JST (UTC+0900)
Decision authority: implementation choice within the user's request to fix requeued steering without restarting the running application.
Supersedes: none; supplements [verified runtime recovery](verified-runtime-recovery.md).

## Context and decision

Cafe combines root and child activity in one visible turn. A successful native root completion can therefore coexist with a running aggregate. Codex's `turn/steer` targets only an in-flight native root; child work cannot make a completed root steerable. Treating the aggregate flag as root authority both rejects live steering and prevents its next-turn recovery.

Expose optional, process-local positive proof of native root completion through the existing authenticated provider inventory. Bind it to the exact root provider thread, completed turn and observed completion time. Omission remains unknown/legacy behavior. Never persist or trust this proof as a substitute for a fresh runtime read. Pending compaction, uncertain native start admission and a newer root revoke eligibility.

Service routing and orchestration may submit saved input as a new native root when that fresh proof matches the expected turn and existing ownership and user-control fences pass. Pin the expected completed root through the final native admission and retain the existing pre-I/O marker/post-I/O receipt. Keep child routes, history and visibility intact; do not interrupt or resend child work.

Native start admission is reserved under the root lifecycle semaphore and bound to an exact request token. A definitive ACK or rejection can release only its own reservation, including when a terminal event arrives before the ACK; an ambiguous transport leaves admission reserved. The aggregate remains running during submission, and its projection advances only when a matching same-instance fresh runtime inventory confirms the replacement ACK. A server-only session-set guard checks the exact old root, provider instance, immutable message and intent sequence again in the engine's serialized command admission. Stop and newer native/projected turns retain priority over late replies, including controls committed during the inventory read or immediately before the projection write. A rejected projection marker still settles the external delivery receipt so it cannot trigger a duplicate send.

Legacy requeued rows may use bounded historical metadata only to schedule one guarded retry of the exact immutable saved message. That UI observation never authorizes provider I/O. A failed fresh check receives a distinct blocker so the same historical cue cannot create a rejection loop.

The legacy retry requires its exact completion warning in the hydrated activity window. If that evidence is unavailable, the saved message stays conservatively queued; it is not automatically resent from silence or a truncated history.

## Alternatives and safety

Do not clear the entire aggregate merely to send, wait indefinitely for unrelated children, or start another root from a UI timer. Do not weaken Stop, newer-input/turn, routing, owner-generation or uncertain-ACK fences. No additional inference, credential handling, transcript replay or sensitive logging is needed. Old daemon snapshots omit the optional proof and fail closed; the normal application restart applies the new runtime code.

## Evidence and operational limits

Runtime, service, reactor and queue regression tests must cover the combined root-complete/child-active/no-active-steer path, mismatched proof, interleaved newer roots and Stop, repeated failures and ambiguous submission. Required repository checks and the forced desktop build remain release gates. No passing local test claims that an already-running old daemon has changed behavior.

Regression coverage lives in `CodexSessionRuntime.test.ts`, `CodexCompaction.test.ts`, `ProviderService.test.ts`, `ProviderCommandReactor.test.ts`, `OrchestrationEngine.test.ts`, `decider.test.ts`, `ChatView.logic.test.ts`, and the composer browser suite. Run the repository-pinned Yarn `test` task, the targeted `@cafecode/web test:browser src/components/ChatView.composer.browser.tsx` cases, and the required final `build:desktop --force` after tests. Provider responses are deterministic fixtures; no live inference or production task mutation is needed for these checks.
