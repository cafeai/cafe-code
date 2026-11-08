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

Behavioral tests cover exact target/instance selection, shared account quota,
unknown counters, transcript-free projection, zero-message limit, credential
rotation/revocation and authenticated transport targeting. Synthetic database
coverage checks exact thread/kind/sequence selection. These tests are submitted
to CI at the user's request; authored tests are not a local execution claim.
Native installation, running-provider adoption and live quota accuracy are
outside this change's qualification.
