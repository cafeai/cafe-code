# Claude public operation visibility

Decision status: Accepted — implementation and release verification remain separate.
Created: 2026-10-09 10:17:43 JST (UTC+0900)
Last updated: 2026-10-09 10:44:22 JST (UTC+0900)
Decision authority: implementation discretion within the user's explicit request to show Claude's public progress and command/output details and push this changeset.
Implementation status: implemented with synthetic focused qualification; whole-repository, final-build and release CI verification remain separate.
Supersedes: none. The narrower authenticated child-history policy remains unchanged.

## Context and alternatives

Cafe already receives nonempty primary thinking deltas, but its assistant
projection intentionally accepts only ordinary text and its work-log projection
does not present those summaries. This drops displayable public updates.
Command rows likewise lack an inspectable received-output preview. Neither
problem authorizes another inference call, hidden reasoning extraction or raw
native-object disclosure.

Forcing the direct API's newer `display: "updates"` beta into the pinned SDK was
rejected: that public option is not admitted by its typed configuration, while
the native CLI already owns model/provider eligibility. Switching every model
to summarized thinking was rejected because it changes provider visibility and
latency policy. Requesting periodic generated status text was rejected because
it adds paid work and can misrepresent the provider's actual operation.

## Decision

Present already-received primary public summary blocks separately from answer
text using a stable reasoning item and a bounded `reasoning.summary` work-log
activity. Bind it to the actual current query, canonical turn, native message
and content block; reject child, hidden, foreign or retired attribution before
projection. Coalesce live block snapshots and flush at supported boundaries.
Retain exact-prefix integrity and replay fences; never append a guessed suffix
or splice summaries into the final answer. Empty/redacted/signature blocks have
no display text. A received summary is labelled generically because native
summarized mode does not distinguish reasoning summaries from progress notes.

Expose only allowlisted bounded Claude Bash command description, command,
received output and status. Derive observed timing from actual lifecycle
receipts, not a guessed duration. Expand with ordinary keyboard-accessible
controls. Keep truncated, empty and unavailable evidence distinct. Never turn
generic JSON, omitted content, MCP/private resource payloads or child histories
into a fallback display.

## Security, privacy and failure consequences

Exact query/block authority and bounded retention/publication prevent summary
mixing and token-rate durable churn. Public text is escaped, inert and minimized;
known credential and terminal/bidi patterns are filtered, without claiming a
complete arbitrary-secret detector. Existing approvals, capability-bearing file
actions, child-history limits and native tool execution remain authoritative.
No provider call, prompt replay, credential read, process restart, dependency
update or model/display-policy mutation is introduced.

Cafe's operational diagnostic copies additionally strip opaque thinking
signatures and redacted blocks, including nested/malformed-parent thinking text.
This is a forward-only log minimization change; older logs are not rewritten and
provider-owned signed conversation context is untouched. Missing or ambiguous
public text cannot be reconstructed; provider omission remains valid.

## Compatibility and implementation evidence

Reuse the existing canonical reasoning item/stream vocabulary and work-log
payload projection. Exact version-1 admission markers distinguish newly
projected primary Claude details from unmarked legacy and future contracts.
No provider wire-schema change or database migration is
needed. Existing bounded snapshots, paging and turn/session result truth remain.
Public summary and command rows require independent synthetic authority,
integrity, privacy and browser interaction qualification alongside the full
repository checks and final forced desktop build. Native hosted evidence must
be recorded separately; a local pass is not a live-account/model guarantee.

Normal rebuilt runtime adoption is required. Source updates cannot backfill data
that was omitted or lost before this implementation. The prior
[response-limit decision](claude-response-limit-recovery.md) remains in force:
preserve received output and offer only explicit editable preparation, without
extending native bounded retries. See [operation visibility](../claude-operation-visibility.md)
for supported display behavior, limitations and replay checks.
