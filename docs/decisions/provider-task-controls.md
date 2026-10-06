# Decision: explicit Claude delivery and exact-task controls

Decision status: Accepted within the user's provider-parity implementation request.
Implementation status: Implemented and released; integrated local and exact-head platform CI gates verified on 36c64874.
Created: 2026-10-05 06:19:58 JST (UTC+0900)
Last updated: 2026-10-07 04:24:34 JST (UTC+0900)
Supersedes: no prior decision. Preserves [runtime observation](subagent-runtime-observation.md), [prepared rewinds](claude-conversation-rewind.md) and [idle-only scheduling](scheduled-followups.md).
Supplemented by: [provider-aware composer menus and recipient binding](provider-aware-composer-and-child-activity.md).

## Released qualification

The integrated release at `36c64874fce05cb037d69737b4833ccf7c37f52d` passed
formatting, lint, typecheck, 6,599 default tests, 934 browser tests, two isolated
native fixtures and the final forced desktop build. [Exact-head CI](https://github.com/cafeai/cafe-code/actions/runs/37258417302)
passed all seven applicable quality/artifact jobs and produced four nonempty
platform artifacts. This is source-bound fixture/build evidence, not a live paid
provider claim; later changes require fresh release verification.

## Decision and authority

Delivery is explicit per human message, not a model preference or a new scheduler.
Omission preserves the existing SDK behavior. Qualified Claude runtimes can accept
Now, Next or Later on the existing durable message/steer path. The selected value
travels with the saved intent and its existing UUID/receipt, including recovery;
it never authorizes replay of possibly accepted input. Scheduled occurrences stay
idle-only and cannot request an urgent priority or be stamped as human input.

Now asks current Claude to take the message into its current work, allowing native
foreground tools to move into the background. Next requests the next available
delivery boundary; Later leaves the message queued behind higher-priority work.
These are native ordering requests, not deadlines or promises to bypass an approval.
Expose this contract only after qualifying the configured native runtime; an SDK
version alone is not evidence about the executable. Unknown or older runtimes
reject explicit choices instead of silently dropping them.

An explicit owner action may stop one task or background one foreground task.
Bind it to the exact Cafe chat, account, originating turn, native runtime generation
and task incarnation. Resolve native task/tool identities only from the actual
adapter's current binding. A title, history ID, stale renderer row or guessed tool
ID provides no mutation authority. Backgrounding always supplies the exact spawning
tool-use ID; the SDK's omitted-ID all-tasks operation is never used.

Persist a mutation attempt before provider I/O. Identical requests reuse the saved
outcome; a changed tuple cannot borrow its receipt. A crash or lost acknowledgement
stays uncertain and is not automatically retried. A stop acknowledgement means only
that the provider accepted the control request: the native terminal task event must
confirm the final outcome. Background acknowledgement does not complete the task.
Keep the parent and sibling tasks untouched. Existing Stop chat retains its current
whole-chat meaning; enabling task controls does not silently change interrupt policy.

Ordinary provider tasks are displayed separately from subagents in Tasks, in
five-row pages. Before Claude publishes a native task ID, a foreground tool may
receive a server-minted, generation-bound background-only reference; no Stop
authority is inferred from its tool ID. Native task binding retracts and invalidates
that temporary reference. Projection orders lifecycle evidence by durable sequence,
then time/id, and requires the current account/runtime before displaying controls.
The same typed metadata crosses runtime ingestion, so reconnects do not reconstruct
authority from prose. A 15-second acknowledgement deadline persists unknown rather
than hanging or replaying; it cannot retract an already-delivered native request.

## Composer presentation amendment — 2026-10-07 04:24:34 JST (UTC+0900)

At the user's request, Message delivery now lives inside the existing effort/
model-options menu, with no persistent strip outside it. Availability follows the
effective selected Claude account and its qualified runtime capability. Draft
priority belongs to the exact environment/chat/account selection; sending captures
it with the message's model/account snapshot. Queued messages retain that snapshot.
An explicit priority may steer only an already running Claude session under the
same selected account; a different native provider/account uses the normal durable
queue instead. After asynchronous attachment preparation, recheck the canonical
session. Bind explicit-priority steer to its account, native runtime and active
turn in the Cafe command and durable event, and reject drift at server admission
and locked provider I/O. This prevents command transit from retargeting the message.
Automatic still omits priority. No native provider protocol, permission, scheduler
or task-control mutation capability is broadened by this UI relocation.

## Detached results and rewind safety

The SDK's `{ detachedToolCall: true }` placeholder says that a tool is still running.
Retain the exact in-flight tool binding until the later result or authoritative
task notification. Do not publish successful tool completion, duplicate the result
or allow a rewind/idle replacement while detached work remains unresolved. Public
tool/task output stays subject to existing bounded redaction and visibility policy.
Task-control acknowledgements never clear approvals, prompt lifecycles or the
whole-tree rewind guard. Late callbacks remain bound to their originating runtime.
Every unresolved native task, including non-agent tasks, fences idle retirement.
Evicting an unresolved binding marks liveness uncertain rather than manufacturing
an idle tree. Native ID reincarnation clears old aliases and retains bounded retired
tool identities so delayed old progress/terminal frames cannot mutate a replacement.
After known native-ID reuse, a lifecycle edge without its spawning-tool identity
is ambiguous and cannot mutate the replacement either. Each extra derived tool
edge receives its own event ID, preventing durable ingestion from deduplicating
the following native task lifecycle event.

## Focused evidence

Credential-free adapter tests cover all priorities at idle/running/tool/approval
boundaries, exact task and foreground-tool controls, stale and missing incarnation
identities, detached WebFetch/WebSearch/MCP results, and unresolved task-map overflow.
Persistence and service fixtures cover concurrent duplicate claims, restart receipts,
the acknowledgement deadline, owner/account validation and no recovery launch.
Runtime ingestion verifies that foreground retraction and native task start/end
survive as distinct durable activities. Renderer fixtures exercise accessible
controls, pending/unknown labels, pagination, out-of-order history and reconnect
queue ownership. These targeted checks do not replace the integrated repository,
browser, forced-build and exact-head hosted release gates.

## Security, compatibility and verification

Owner authentication, exact generation checks, bounded metadata and durable attempt
ownership precede provider mutation. Provider errors are reduced to fixed public
messages. No task-control bearer, credential, native path or raw exception enters
renderer state. No new process launcher, provider install, paid probe, background
service or global profile edit is introduced. Themes and reduced-motion conventions
remain unchanged.

Credential-free tests must cover priorities and UUID correlation, queued/approved/
reconnecting states, detached-result settlement, forged and stale task bindings,
duplicate operations, concurrent terminal events, uncertain acknowledgements,
parent/sibling isolation and real browser controls. Existing native-rewind fixtures
remain part of the regression boundary. Run all repository checks and the final
forced desktop build before publishing; synthetic passes do not claim live-provider
or foreign-platform execution evidence.
