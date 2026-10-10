# Passive Claude session quota reports

Decision status: Accepted — passive implementation; release verification is tracked separately.
Last updated: 2026-10-09 08:52:36 JST (UTC+0900).
Decision authority: explicit user authorization to implement the passive alternative and push it to dev. Supersedes: the proposed independent quota reader/Refresh design, not existing authentication or usage accounting.

## Context and decision

Claude's pinned Agent SDK 0.3.288 describes a structured `usage_report` sibling on
an assistant response to a user-requested native `/usage` command. It contains an
ordered server meter list and optional extra-usage data. The existing sparse
`rate_limit_event` is not a full report and cannot reconstruct all weekly,
model-specific or surface-specific limits.

Cafe projects reports already emitted by an existing query. It does not send
`/usage`, call the experimental usage getter, launch an inspection query, scan
transcripts, read credentials or change provider policies to obtain a report.
Settings, the session rail and the context popover use one presenter. There is
no independent quota Refresh button; the user can request `/usage` through the
existing command path when the configured native runtime supports it.

The report is **session-reported**, not an independently verified current account
allowance. The public report carries no stable authenticated principal or auth
epoch. Configuration and session commitments establish where Cafe received it;
they cannot prove which remote identity a provider used or that its cached result
is fresh. Receipt time is labeled as receipt time, not upstream measurement time.
Missing reports never imply zero usage, an unlimited plan or a logged-out account.

## Alternatives and integration limits

An independent cold inspection was rejected. An empty SDK input iterable does
not establish a no-inference boundary for managed startup hooks, and the public
API does not expose a quota-attached principal/epoch. A profile path, email,
organization, successful local login or configuration hash cannot supply that
missing authority. There is no direct private OAuth endpoint, credential scraping
or wrapper around internal provider transport.

This feature adds diagnostic presentation, not a new authentication flow or
subscription-capacity offering. It does not establish blanket provider approval
of Cafe's existing integration. The published [SDK getting-started guidance](https://code.claude.com/docs/en/agent-sdk#get-started),
[authentication and credential-use guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
and [Claude-plan SDK guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
have different scope and conditions. Applicable agreements still govern existing
use; reopening independent inspection requires a new authority and policy review.
No dependency, native CLI, auth environment or billing setting is changed here.

## Ingress and privacy

`claudeSessionQuota.ts` reads only bounded own data properties, including dense
array indices. Inherited entries and accessors are rejected without evaluating
them; array constructor/species hooks are not used. At most 128 meter rows are
admitted; labels reject controls, bidi controls and malformed UTF-16.
Percentages are finite values from 0 to 100, unlike the sparse event's 0-to-1
utilization. Reset times become canonical UTC timestamps or remain explicitly
unknown. Extra-usage amounts remain safe nonnegative integer minor currency
units. Unknown currency is not guessed to be USD. Unsupported or malformed
complete reports become unavailable rather than leaving a partial list labeled
as a complete report. Unknown meter kinds/groups and duplicate rows are retained
in source order, not collapsed into historical model names or two quota buckets.

The adapter removes the structured sibling before native debug logging,
canonical raw events, activity projection and usage accounting. Only an already
established primary native session belonging to the current non-stopped query
can replace its volatile report. Pre-initialization, foreign, nested and retired
sources cannot establish a thread or synthetic turn from quota telemetry. Normal
user-requested `/usage` response text retains the existing assistant-text path;
this is not a promise to hide text the user explicitly requested.

The optional `ProviderSession.quotaReport` is volatile owner inventory metadata,
not a session-binding database field, durable status cache or event-journal
payload. Replacement is complete, including null/empty levels. Native reset,
rebind, query retirement and stop admission clear it. Coalesced 50 ms runtime
publication contains only the `quotaReportChanged` Boolean, never report values.
Restarting the execution owner/runtime therefore loses the observation until
another report is received; Cafe does not backfill it from saved transcripts.
Reconnecting a presentation backend may reread a surviving owner's inventory
after source revalidation. Rewind snapshots explicitly omit report/catalog/private
configuration metadata on both encode and decode, including old stored fields;
all durable recovery cursor/runtime fields retain their existing schemas.

## Owner delivery and source authority

Owner-only `server.subscribeProviderQuota` reads the existing runtime inventory.
An exact chat request includes Cafe instance/thread/runtime ids, never a native
session id or client-supplied path. Settings may select the newest observation
among that configured instance's currently eligible saved sessions. It must not
borrow an archived, deleted, stopped, foreign-workspace or replaced runtime.

Saved shell authority, exact workspace cwd and the query's captured configuration
commitment are revalidated around the inventory read. Configured environment
changes also invalidate authority. Standalone workspace resolution remains
read-only with its existing ownership admission. Duplicate runtime ownership is
inconclusive. Metadata values and configuration commitments never enter RPC
traces; the stream explicitly disables tracing. Older remote owners without the
optional metadata return unavailable, with no competing local fallback.

Invalidation subscriptions start before the initial read. One trailing slot
coalesces changes; an invalidation generation fences late publication, including
relevant configuration/session ABA changes. Reads have a five-second bound and
errors return unavailable without retimestamping old values. Closing a consumer
cancels only its metadata stream, never a provider query. No polling or automatic
provider calls are introduced.

## Presentation

The shared presenter shows each meter's kind, group, optional model/surface,
severity and active status with percentage remaining and reset information.
Receipt/reset dates use the viewer computer's locale/timezone and include the
zone label. A passed reset or an old receipt makes the observation stale; it does
not refill the meter or manufacture a newer report. Extra usage is separate from
plan quotas, with disabled, absent and unknown amounts/currency explicit.
Context-window tokens and Cafe's processed-token/API-equivalent cost accounting
remain separate and unchanged.

Visible consumers subscribe through the selected environment's existing
connection. The renderer immediately clears old scope on configured instance or
selection, configuration,
chat, runtime or environment changes and disconnection, and revalidates on
reconnect. An absent first response has a six-second renderer bound. Missing or
unsupported reports provide user-controlled `/usage` guidance without adding an
execution button that secretly sends a message.

Anonymous legacy Claude rate-limit events cannot meet this exact source fence,
so these consumers do not use them as fallback during loading, unavailability
or disconnection. Their existing collection/accounting and Codex/Grok rendering
remain unchanged. Source clearing does not claim detection of otherwise
unreported credential-principal changes inside the provider.

## Qualification and adoption

Credential-free contract, mapper, adapter, subscription, owner-wire and browser
fixtures cover malformed/hostile input, ordered replacements, source rejection,
late reads, cancellation, isolation, local timezone labels and shared rendering.
The browser fixtures also cover theme/scale and unavailable states. The existing
macOS/Windows focused CI subset includes the shared report presenter and hook;
Linux retains the full browser suite. This is renderer/source-bound qualification,
not a real-account allowance or native provider compatibility claim.

Required repository checks and the final forced desktop build apply before push.
Normal rebuilt backend/session adoption supplies the new adapter behavior; no
live query is restarted or repaired merely by opening Settings.
