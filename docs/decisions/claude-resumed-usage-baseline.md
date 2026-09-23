# Decision: subtract restored Claude usage without recounting history

Decision status: Accepted
Created: 2026-09-23 10:22:48 JST (UTC+0900)
Last updated: 2026-09-23 10:55:31 JST (UTC+0900)
Decision authority: implementation choice within the user's request for current provider compatibility and correct token/cache accounting.
Implementation status: Implemented and verified.
Supersedes: None. Supplements the query-scoped usage policy for providers that restore session totals.

## Context

Claude Code 2.1.277 and its matching SDK documentation changed the scope of resumed/forked `modelUsage`: results can include saved earlier native-session spend. Cafe creates a fresh random accounting epoch for each query. Treating the whole restored result as new usage would duplicate already-recorded tokens and incorrectly attribute inherited fork history to the new task. The public SDK fork currently used by Cafe omits `cost-state`, while the native CLI fork can preserve it; apply an offset only when matching metadata actually exists.

The public initialization response does not provide the restored numeric baseline. The experimental usage getter is not a free local baseline handshake: it can read subscription usage over the network, and its response can race automatic resumed work. A stable epoch alone cannot distinguish forks, older CLI counter resets, missing historical observations and concurrent bindings.

## Decision

At actual native resume preparation, read only the exact session's last complete numeric `cost-state` metadata from its validated private transcript path, with finite byte, line, entry and time bounds. Retain only validated numeric per-model counters; neither prompts nor assistant content enter accounting state or diagnostics. Do not emit or backfill this historical usage. It is an offset used to subtract history from subsequent native cumulative totals.

Use the native initialization version to distinguish versions that restore totals from older query-scoped behavior. Fresh sessions and explicit conversation resets start at zero. Preserve primary-message deduplication, cumulative per-model settlement, private random Cafe epoch identities and the transactional usage ledger.

Native saved rows can omit the canonical model name present in live results. Normalize an offset only through the exact raw row's live `canonicalModel`, verifying row-level monotonic counters before combining aliases. Never infer aliases from string similarity or move already-published attribution between model buckets.

When no trustworthy baseline exists, do not guess or add historical totals. Retain observed new primary input as explicitly incomplete accounting and establish an offset for later results. This may undercount unavailable initial output/child usage; it must not be presented as complete billing data. Conversation execution does not fail merely because optional accounting metadata is unavailable.

## Alternatives and rationale

- Replaying a prompt or requesting a model-generated baseline risks duplicate actions and token charges; rejected.
- Reading whole transcripts or rebuilding historical usage is unbounded, private-content-heavy and contrary to existing accounting policy; rejected.
- Treating the first resumed result as all new double counts history; rejected.
- Discarding every first resumed result avoids inflation but loses observable new usage even when an exact numeric baseline exists; reserve conservative fallback for missing/untrusted evidence.
- Changing to one native-session ledger key exposes native identities and breaks fork/legacy behavior; preserve the current Cafe-owned ledger boundary.

## Security and compatibility consequences

This adds a narrow read-only native metadata dependency at resume time, not a per-token filesystem scan. The reader must reject unsafe paths/symlinks, enforce exact session identity and finite resource limits, validate safe integer categories, and detect file replacement/change where identity evidence is needed. Unsupported, malformed, oversized or incomplete evidence fails closed to incomplete accounting. Never log transcript lines, raw errors, paths, session identifiers or credentials.

Provider stream and public API semantics remain authoritative. Do not rewrite native records, credentials, prompts, tool catalogs or cache settings. Existing native cursor recovery and explicit Stop behavior stay unchanged. No database migration or retrospective usage repair is authorized by this decision.

## Evidence and acceptance

The [official cost-tracking contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking) documents restored session totals. Exact SDK 0.3.278 artifacts and native implementation establish the numeric metadata shape; the compatibility audit records provenance.

Verification covers fresh, resumed, forked, reset and legacy version behavior; multiple models, exact live alias mapping and repeated results; unknown/incomplete baseline; malformed/oversized/non-monotone counters; exact-session/path ownership and file races. The focused Claude suites passed 188 tests and the full repository suite passed 4,505 tests. Public APIs and test fixtures perform no inference and access no real provider credentials. Required formatting, lint, typecheck and the forced desktop build passed.
