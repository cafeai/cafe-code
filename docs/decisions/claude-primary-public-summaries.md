# Primary-chat presentation of Claude public summaries

Decision status: Accepted — implementation verification remains pending.
Created: 2026-11-03 14:26:25 JST (UTC+0900)
Last updated: 2026-11-03 14:26:25 JST (UTC+0900)
Decision authority: the user's explicit request to show received public Claude summaries as normal text in the primary chat.
Implementation status: source and synthetic regressions prepared; repository checks, final build and runtime adoption remain separate.
Supersedes: [Claude public operation visibility](claude-operation-visibility.md), only its placement of admitted Claude summaries in the secondary work log.
Superseded by: none.

## Context and alternatives

Cafe already admits bounded public Claude summaries under exact query, turn,
native message and content-block ownership. Placing this text inside a collapsed
work log can hide useful progress that the provider has already sent. The user
requested ordinary primary-chat presentation.

Keeping only the work-log placement does not satisfy that request. Converting
summaries into canonical assistant messages would give progress text unrelated
message, history and completion semantics. Fetching all old summaries on opening
a chat would bypass the existing bounded history policy. Instead, the timeline
can reuse the admitted activity data and give it a distinct primary row.

## Decision

Render validated version-1 Claude public summaries with the ordinary sanitized
`ChatMarkdown` renderer in the primary conversation. Each exact turn/block
operation retains its own stable row, first receipt position and latest retained
text/status. Interleaved commands retain their order, including equal-clock
receipts. There is no collapse or thinking header; updating, partial and
truncation notices remain visible when applicable.

Use the current work entries and bounded retained activity snapshot, including
admitted prior-turn summaries already present there. Do not add eager history
queries, a database migration or backfill. Summaries outside that snapshot remain
available through the existing explicit paged work-log reader. Suppress a
secondary duplicate only for the exact Claude turn/block already shown in the
primary timeline; equal text or another provider's reused item id is not identity.
OpenCode thinking remains secondary.

## Security, privacy and failure consequences

The existing ingestion contract remains the only disclosure authority. Raw,
hidden, redacted, child, foreign, unmarked legacy and future-version payloads
cannot gain primary presentation through this change. Preserve exact streamed
prefix commitments, bounded replay fences, stable upserts, one-second live
coalescing, block-count limits and the latest 4,096 UTF-16 characters with honest
truncation. Credential-pattern minimization, control/bidi filtering and diagnostic
signature/redaction stripping remain in force. Arbitrary secret detection is
not guaranteed; the authenticated owning chat remains the disclosure boundary.

A primary summary row has no canonical assistant message identity, fork/revert
action, attachment or checkpoint authority. It does not complete a turn, prove
a tool succeeded or alter result/accounting truth. Missing or partial provider
text stays missing or partial. No inference, prompt, native display mode,
permission, model or effort setting changes.

## Implementation and verification

The existing summary activity projection is unchanged. `session-logic.ts`
derives distinct provider-summary timeline entries and separates provider item
namespaces; `MessagesTimeline` renders them and filters exact work-log duplicates.
The normal Markdown renderer retains its existing sanitization and link policy.

Synthetic selector and native browser regressions are prepared for admission,
identity, ordering, live replacement, prior-turn retention, duplicate suppression
and visible normal-text rendering. Their execution, complete repository checks
and the final forced desktop build are pending for this changeset. A local pass
would not prove live-account/model behavior or adoption by an existing process.
See [the November 3 provider review](../provider-updates-2026-11-03.md) for package
admission and the separate SDK durability notice.

## Preserved decisions

The predecessor's public-text admission, privacy, resource bounds, command
inspection, native result truth and operational logging decisions remain in
force. Only the Claude summary presentation location is superseded. Older
omitted data cannot be reconstructed by a source update. See
[operation visibility](../claude-operation-visibility.md) for the current behavior
and historical-reader limits.
