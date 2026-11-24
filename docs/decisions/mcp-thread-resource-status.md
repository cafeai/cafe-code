# Metadata-only MCP thread resource status

Status: Accepted design; implementation and verification tracked separately.
Created: 2026-10-31 17:59:36 JST (UTC+0900)
Authority: User requested context/quota access through Cafe MCP, dev publication,
CI testing, local dev synchronization and a rebuilt bundle.

## Context

Agents need to inspect context headroom and provider allowance before
exhaustion. The renderer already combines thread context activities with
cached provider-account rate limits. Loading messages for this question is
unnecessary. Context is thread-specific, quota is account-shared, and neither
a saved override nor a signed launch request proves current native adoption.

The management endpoint is owner-authorized and already permits explicit
cross-chat reads. Providers can run in a detached daemon with a separate
credential-service instance, so process-local token-to-thread maps cannot
provide reliable default targeting. Arbitrary manually issued subject text
also cannot distinguish internal launch intent.

## Decision

Register the read-only `get_thread_usage` tool with an optional explicit Cafe
thread ID. An omitted target requires a bounded dedicated signed
`managementLaunchContext` issued by Cafe's internal provider launch path.
Credential verification propagates this claim; rotation preserves it and
scope disposal revokes all issued credentials. Ordinary/manual credential
issuance cannot set it. Authenticate `/mcp` using its bearer credential rather
than allowing an owner cookie to satisfy an invalid bearer. Other routes
retain their existing authentication behavior.

The binding chooses a default Cafe chat only. It grants no additional owner
authority, attests no successful provider opening and does not identify an
inheriting native subagent. Expose current-vs-launch instance comparison only
when projected identity is available. Manual/legacy clients supply a target.

Read a single newest context activity through a partial index matching the
canonical nullable-sequence/time/id ordering, plus the active chat shell and
cached provider registry. Reuse pure context and quota derivation with the
renderer. Never hydrate messages, list native sessions, refresh an account,
or make a paid request. Prefer the exact session provider instance over the
saved next-turn selection and explicitly label legacy configuration fallback.

Return a bounded metadata whitelist, with observation times, explicit unknown
values, account-shared scope and exact separate quota buckets. Historical
context reports have no owner generation and must say so. Do not invent a
freshness TTL, allocation, currency, native capacity or hidden compaction
trigger. Public failures use fixed text instead of native/SQL errors.

## Alternatives and consequences

A required explicit target would preserve safety but prevent convenient
self-inspection in new Cafe-issued connections. Caller headers, subject
parsing, current UI selection or a sole live session would be untrusted or
ambiguous defaults. Full thread-detail reads unnecessarily hydrate content
and can omit older context rows from a busy activity tail. Live refresh would
change the cost and ownership semantics of a status read.

Old running connections receive no retroactive claim and remain usable with
an explicit ID. Newly built source does not adopt itself into running
providers. Cached and historical data can be stale, and unsupported provider
quota remains unknown. Existing management enablement and owner requirements,
scheduling and visualization authorization remain unchanged.

## Verification boundary

### Thread-independent account usage successor

The owner requested direct account usage across providers in one MCP call,
including Claude's normal and Fable/model-scoped meters, extra usage and reset
metadata. Add `get_provider_usage`, with optional exact instance/name filtering
and the existing bounded live pagination, without requiring a chat or launch
context. Route quota-only questions directly to it; reserve the once-per-connection
context discovery for chat work. `get_thread_usage` retains its passive contract.

Reuse the registry's exact-instance account reader already used by Settings for
Claude's full report, including its replacement checks, native control-only
execution, single-flight cache and joined cancellation. Bound direct-reader
concurrency to two under a shared 15-second budget and retain completed sibling
results after timeout. This is the explicit narrow exception to the original
tool's no-native-read decision, not permission for session inventories, paid
requests, full provider refreshes or reset redemption. Preserve every reported
meter independently of selected model, plus extra-usage missing/null/disabled
distinctions and native minor currency units.

Return cached sparse rate limits separately with their own timestamp, plan/spend
metadata and bounded reset-credit rows; do not merge their older windows into a
full Claude report or invent model-specific allowances. Existing authentication,
owner enablement, receipt, cache, native cleanup and adoption limits remain.
The direct account read is annotated read-only/open-world because it may consult
the configured provider through that control-only reader. Source tests qualify
the MCP response, unknowns, resource limits and cancellation; a build does not
prove an already-running backend/provider discovered the new tool.

Behavioral tests cover exact target/instance selection, shared account quota,
unknown counters, transcript-free projection, zero-message limit, credential
rotation/revocation and authenticated transport targeting. Synthetic database
coverage checks exact thread/kind/sequence selection. These tests are submitted
to CI at the user's request; authored tests are not a local execution claim.
Native installation, running-provider adoption and live quota accuracy are
outside this change's qualification.
