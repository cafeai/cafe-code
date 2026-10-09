# Decision: explicit Claude budgets and received workflow presentation

Decision status: Accepted within the user's explicit implementation/push request.
Implementation status: Implemented; source-bound verification and release gates below must be checked for each revision.
Created: 2026-10-09 13:03:52 JST (UTC+0900)
Last updated: 2026-10-09 13:03:52 JST (UTC+0900)
Decision authority: agent implementation discretion within the requested per-account output limits, native Max/Ultracode and workflow display.
Supersedes: none. Supplements [response-limit recovery](claude-response-limit-recovery.md), [task controls](provider-task-controls.md) and [lifecycle retention](subagent-lifecycle-retention.md).

## Context and alternatives

An exhausted 64K response can spend its budget reasoning without a final answer.
The user explicitly requests account-specific larger budgets and the native
workflow mode/details visible in Claude. Max is an effort value; Ultracode is a
separate mode. A blanket budget increase, invented effort alias, private settings
fetch or workflow-journal scrape would obscure cost, eligibility and disclosure.
Native bounded recovery and deliberate user-send boundaries remain unchanged.

## Decision and flow

Validate optional integer `maxOutputTokens` in full/patch contracts, opaque
per-Claude-instance persistence and interactive launch. Fail malformed persisted
policy without rewriting its bytes. Copy the selected account environment and
set only the explicit response budget. Non-chat helpers deliberately select the
existing home/concurrency fields rather than inherit this new Cafe setting;
their preexisting inherited environment is not stripped. Clearing means omission,
not an upstream profile or global environment edit. The existing account Save
reconciliation/lifecycle is retained, with its session-reload warning.

Catalog capability and observed stable native version gate the distinct
Ultracode Boolean. Use public typed `Options.settings.ultracode` at startup and
`Query.applyFlagSettings` for changed concrete effort/mode on the same admitted
query. Include a selected Boolean during effort updates; use native reset when
removing it. Preserve all permission, model, cwd, environment and account rules.
Requested state is not proof of applied eligibility. Native settings files,
private control APIs and policy overrides are not used.

An isolated decoder consumes the qualified native 2.1.288 `workflow_progress`
extension passively. It accepts bounded own-data phase/agent fields, drops private
siblings, rejects ambiguous indexes and gates publication on visible primary
frames from the exact live initialized query/session. Explicit snapshots replace;
omission/malformed input retains good prior evidence. Ambient transitions publish
only root provenance for retraction, never snapshots. Late terminal progress does
not rewrite the terminal snapshot; explicit native task reincarnation clears it.
Rejected task diagnostics use the finite native allowlist too, preventing the
warning path from copying private workflow fields.

The adapter retains at most 32 snapshots of 128 combined rows. Ingestion stamps
the exact query/account provenance and mints a content-free SHA-256 retention key
from the full `(turn, task, account, runtime)` tuple. Migration 090 replaces both
existing activity-maintenance triggers together, preserving ordinary/ambient
identities, UTF-16 bounds and hard-delete fences. New workflow identities use
bounded ASCII ownership and exact lowercase digest admission. There is no global
startup scan or historical backfill. Existing exact-thread yielding hydration
and indexed latest-edge retention share the 4,096 identity ceiling; phase/agent
indexes do not consume independent lifecycle slots or become task authority.

The renderer schema-validates provenance and snapshots, maintains the same exact
tuple during retention/replay, and shows paged recent workflow cards independently
of the active-only canonical child roster. Models/counters/outcomes remain
received evidence. Root controls reuse existing durable, exact-incarnation
receipts; phase/agent rows have no history or mutation routes.

## Security, cost and compatibility consequences

Budget increases are intentional and can cost more or compact earlier; native
model/service ceilings and child-agent budget policy remain authoritative.
Neither larger budgets nor Ultracode guarantee completion. Ultracode may bypass
native large-run caution/Auto first-workflow consent and ordinary Agent-tool
concurrency caps by its documented design; it does not bypass tool permissions.
Its requested-use description makes the larger orchestration explicit.

Only bounded public telemetry enters workflow presentation. Prompts, opaque agent
IDs, private error/output previews, arbitrary paths/logs and unknown siblings are
excluded. Label minimization cannot prove arbitrary text is nonsensitive. Token
snapshots are not added to billing or main context accounting. Missing data never
authorizes fallback reads, synthesized success or a provider operation.

No dependencies, provider installation, profile, process ownership, rewind,
automatic retry/replay or platform launcher policy changes. Normal rebuilt
backend/query adoption is required, not live repair. The untyped received sibling
is a version-qualified compatibility extension, not a promised SDK interface.

## Evidence and release gate

Credential-free tests must cover strict cap settings/read/launch/clear boundaries,
helper/account/global isolation, stable version/model gates, public settings
updates/reset and requested labels. Workflow fixtures cover visible/ambient,
foreign/child/pre-init/retired frames, exact incarnation reuse, sensitive diagnostic
escape, duplicate/malformed/oversized rows, incomplete snapshots, index-bound
replay retention, trigger update/delete and permanent retirement.

Browser tests qualify normal/reduced-motion themes, interface-scale/narrow layouts,
keyboard controls, inert agent rows, explicit progress, unavailable values,
pagination and root-only receipt actions. Linux keeps full coverage; the existing
macOS/Windows subset also includes the affected controls/rail. Required repository
fmt/lint/typecheck/default/browser suites and final forced build precede the
authorized push. Exact-head CI/jobs/artifacts are a separate release gate; local
passes do not prove live account entitlement or native foreign-platform behavior.

See [the user guide](../claude-runtime-options.md) for supported range, upstream
references and adoption details.
