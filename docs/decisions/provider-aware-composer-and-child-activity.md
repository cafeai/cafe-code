# Decision: provider-aware composer menus and bounded child activity

Decision status: Accepted within the user's explicit UI cleanup and subagent-history request
Implementation status: Implemented; verification requirements and operational limits are below
Superseded by: [Useful bounded subagent activity details](subagent-activity-details.md) for category-only activity disclosure; composer, priority binding, ownership and retention decisions remain unchanged.
Created: 2026-10-07 04:40:05 JST (UTC+0900)
Last updated: 2026-10-07 04:51:30 JST (UTC+0900)
Decision authority: the user requested menu-only provider controls, exact selected-provider behavior, and useful activity when opening subagents
Supersedes: the separate review-tab presentation in [native Codex review](codex-native-review.md); supplements [Claude controls](provider-task-controls.md) with priority-recipient binding and [public subagent history](subagent-public-history.md) with content-free tool categories

## Context and alternatives

The persistent review tab and Claude delivery strip cluttered the composer. Review
availability also followed the saved session instead of an unsent provider/account
selection. Moving priority to that effective selection exposed a routing hazard:
a native steer has no model/account override, so attachment preparation or command
transit could otherwise send selected-account urgency into another live session.

Subagent detail deliberately displayed only public user/assistant prose. A worker
performing tools without commentary could therefore look empty. Separately, the
daemon's explicit projection dropped safe phase/timestamp/incomplete metadata that
the provider service already admitted. Copying raw tool history would violate the
existing privacy and resource boundary; removing that boundary is not authorized.

## Decisions

Keep **Codex review** and qualified Claude **Message delivery** inside the existing
effort/model-options menu in wide and compact layouts. No standalone tab, strip,
reserved margin or replacement badge is needed. Existing theme tokens remain.
Codex review requires the actual selected account to match the saved ready native
session. It is not a Claude review implementation or a hidden model fallback.
The controlled dialog lives outside the transient popup, survives busy submission
settlement, and retires on chat/account/runtime/permission binding changes. Its
portalled form cannot submit the ordinary composer draft. The permission disclosure
uses the saved native session mode, not draft settings. Old `codeReviewCollapsed`
storage may remain inert; no migration or profile edit is necessary.
An acknowledgement from a retired dialog cannot close its replacement, even when
the owner switches back to the same account before that acknowledgement arrives.

Claude draft priority belongs to environment/chat/selected account. Capture it with
each immutable message/queue snapshot. Mismatched native sessions use the normal
queue; recheck after asynchronous preparation before claiming a queued message.
New explicit-priority steer commands carry `expectedPrioritySession`: exact account,
active turn and nullable runtime identity. Null matches only null legacy evidence,
never an arbitrary runtime. Canonical command admission, persisted intent processing
and the lifecycle-locked provider service validate this tuple. A stale binding is
a failed, unsubmitted request—not authority to start another turn or replay it.
The Claude adapter rechecks the exact context and turn after attachment preparation,
then admits and attributes the prompt synchronously to its unbounded input queue.
Native results, terminal command-lifecycle frames awaiting projection, and ended
streams fence explicit-priority admission; ordinary token deltas do not. This
closes the completion race outside the provider service's lifecycle lock without
changing ordinary delivery or interpreting a diagnostic as terminal state.
Start-to-steer conversions capture the admitted recipient too. Existing non-priority
steering, provider permissions, scheduling and native protocols remain unchanged.

For verified Codex and Claude child history, derive only fixed categories: command,
file read, file edit, agent message and generic tool use. Do not forward tool names,
arguments, output, commands, paths, recipient identities or private reasoning.
Native typed discriminants/known tool names select a category; shell text is never
parsed or executed. Claude server/MCP tool-use blocks get only the generic category.
These labels do not claim completion or liveness.

Retain the newest 128 activity entries in provider order and report activity cutoff
separately from public-message truncation. Codex keeps its existing isolated reader,
line/page/item/byte/deadline limits. Digest-derived presentation keys keep overlapping
native windows stable without exposing native item IDs; keys carry no authority.
Claude uses the existing authorized bounded history read and sequence keys. No new
poller, paid inference, live provider subscription or full-history hydration is added.
Activity appears separately from public prose because absent timestamps cannot
justify an invented merged chronology. Existing refresh coalescing, safe snapshot
retention, identity reset and follow-tail behavior include activity changes.

## Security, compatibility and failure consequences

The original exact child/root/account/history authorization remains mandatory before
any provider read. Reconstruct allowlisted entries at adapter, service and daemon
boundaries. Both authenticated transports share enum/key/timestamp/count validation
and the existing total encoded-byte ceiling. Preserve safe phase, timestamp and
incomplete metadata across the daemon. Malformed payloads fail closed; unavailable
history keeps honest retry/last-snapshot presentation rather than fake activity.

New activity fields are optional for old daemons. Old priority events remain readable,
but missing recipient evidence cannot authorize future provider I/O; the owner must
review any failed saved message before explicitly sending again. Rebuilt backend and
normal session adoption are required; source changes do not live-update old processes.
No database migration, dependency, provider credential, permission or launcher change.

## Verification and limits

Credential-free fixtures exercise actual composer menus, provider/account changes,
dialog lifetime and no draft submission; immutable priority snapshots; command and
runtime recipient races; private payload filtering, native pagination/deduplication,
bounded tails; daemon projection; and subagent detail refresh/selection/scroll behavior.
Run pinned Corepack Yarn formatting, lint, typecheck, default and browser suites,
then the final forced desktop build. Native cross-platform hosted CI is separate
from local synthetic verification. Tests do not claim paid provider execution or
repair of already running sessions.

The predecessors retain their historical decisions and qualification. Native review
targets, sandbox/approval disclosure and uncertain acknowledgements remain unchanged.
Subagent raw tool payloads remain excluded; the new surface contains categories only.
