# Decision: useful bounded subagent activity details

Decision status: Accepted
Created: 2026-10-07 05:56:19 JST (UTC+0900)
Latest revision: 2026-10-07 06:07:08 JST (UTC+0900)
Decision authority: The user explicitly requested the file names and commands behind generic subagent Activity labels.
Implementation status: Implemented; focused extraction, transport and browser regressions pass. Full repository and native hosted qualification remain required.
Supersedes: The category-only activity presentation in [provider-aware composer and child activity](provider-aware-composer-and-child-activity.md), and only the prohibition on separately sanitized activity display details in [public subagent history](subagent-public-history.md)

## Context and alternatives

An operation list containing only “File read” and “Command” does not tell the
owner what a worker is doing. Copying raw native tool payloads would disclose
credentials, private source/output, unrelated metadata and unbounded text. Keep
the existing fixed category and add a narrowly derived display detail instead.
Do not use an inference model, request another provider operation or execute a
command to produce a label.

## Decision

Each activity may carry an optional single-line `detail` of at most 512 UTF-8
bytes. Known typed file actions and recognized Claude file tools may disclose
their sanitized target path; known command inputs may disclose a conservative
command summary. The category-only fallback remains valid for old daemons,
missing native metadata and unsupported tools. No invented file name or command
is substituted when the history lacks evidence.

Command summarization is bounded and non-evaluating. It retains admitted
executable/subcommand/option names and safe file operands, strips environment
assignment values, and hides secret-bearing arguments, search patterns, request
headers/bodies, URLs and arbitrary script text. Unsupported or complex command
syntax does not become raw display text. Explicit omission labels make the
reduced description truthful. This is conservative display minimization, not a
claim that arbitrary user-chosen strings can be proven free of every secret.

The detail appears below the category in selectable, wrapping monospace text,
using the existing colors. It is plain escaped text, never Markdown, a runnable
command, a file-open link or another permission-bearing control. Timestamps and
the existing newest-128 retention, history cutoff, identity reset, refresh and
scroll behavior remain.

## Security, privacy and compatibility

The exact immutable chat/turn/child/history/account authorization remains
mandatory before reading provider history. Resume cursors, configured provider
homes, routing cwd and native identifiers are not new display fields. The
separate permitted file path comes only from the selected child's admitted
operation metadata. No provider errors, output, private reasoning, arbitrary
tool payloads or recipient identities are disclosed. Diagnostics and durable
task activity receive no new text.

Provider adapters derive the detail before discarding raw native items. The
shared canonicalizer bounds it; both authenticated service and daemon
projections reconstruct the allowlisted DTO, with shared schema validation of
Unicode, controls and byte limits. The existing encoded-response budget remains.
The optional field is additive and requires normal rebuilt runtime adoption;
there is no migration, provider restart, live-session repair or profile mutation.

## Verification and preserved decisions

Require synthetic Codex/Claude extraction fixtures, adversarial credential and
complex-command filtering, Unicode/size/transport tests, and actual browser
rendering/refresh/selection tests. Run the repository full checks and final forced
desktop build, then qualify the exact pushed source on the native CI matrix.
Synthetic tests are not live-provider execution evidence.

All earlier ownership, finite retrieval, non-replaying lifecycle and public-text
retention decisions remain in force. The predecessor documents are preserved
with successor links; only category-only activity disclosure is superseded.
