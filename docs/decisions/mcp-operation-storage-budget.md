# Bounded MCP operation receipt storage

Last updated: 2026-11-15 07:06:55 JST (UTC+0900)

Decision: accepted within the user's request to repair MCP mutation capacity.
Implementation and targeted qualification are tracked separately from deployment
or adoption by an already-running backend.

## Context

Every management mutation reserves an exact bearer-session/request UUID before
calling its handler. The durable row binds the tool and canonical argument
digest, retaining uncertain and failed attempts because partial effects remain
possible. Previously all rows counted equally toward a global 10,000-row cap.
Small settled receipts could therefore exhaust admission during ordinary use
within a long-lived credential namespace. Restarting does not erase SQLite.

Removing settled or failed rows would withdraw duplicate-execution protection.
Shortening credentials would change renewal and sleep/wake behavior without
repairing existing valid namespaces. Raising an unqualified row cap would spend
the full possible result allowance for every extra row. These alternatives are
not adopted.

## Decision and data flow

Version 1 uses a fixed logical byte budget equivalent to 10,000 full result
reservations plus minimum metadata charges. The frozen policy is defined in
`apps/server/src/mcp/operationStorage.ts`; migration 109 imports the same fixed
SQL expression. A future formula requires a new version and migration.

Each row charges the greater of a positive metadata minimum or structural
allowance plus the exact UTF-8 bytes of all eight metadata fields. Unconfirmed
and scheduled rows additionally reserve the full existing result maximum.
Recorded, completed and failed rows charge their actual retained JSON bytes.
The result maximum remains unchanged. The positive minimum bounds row count.
This is a logical accounting bound; SQLite pages, indexes, WAL and free space
have separate physical costs.

A generated column computes each final stored row's charge. A singleton stores
aggregate bytes and row count. Native INSERT/UPDATE/DELETE guards and accounting
triggers commit or roll back with the receipt statement. Duplicate replacement
cannot bypass retained claims. Missing or invalid accounting fails closed rather
than treating unknown usage as empty. Settlement charges the final state and
merged result, so a late scheduled write cannot undo terminal preservation.
Rejected growth retains the old row and counter together.

Migration backfills all existing claims without deleting or reconstructing
outcomes. Unusually large legacy metadata may already exceed the budget;
shrinking or deleting rows remains possible, while positive growth is refused.
Admission checks existing IDs before requesting more capacity and independently
checks the counter inside its transaction. Indexed expiry pruning uses a finite
batch as the possible small-receipt population grows. No current credential is
shortened, revoked or reassigned by this change.

## Interface, privacy and failure behavior

`get_cafe_context.operationStorage` exposes only aggregate charged bytes, budget,
available bytes, count and fixed scope/version. A missing diagnostic is null.
Diagnostic failure does not hide otherwise available chat context. Observations
grant no reservation, retry or native completion authority. Actual action
admission remains transactional and capacity refusal precedes the handler.

The ledger continues storing hashes, public outcome identifiers, fixed errors
and timestamps, without copying prompts, answers, credentials or configuration.
Exact bearer ownership, argument binding, unknown-ACK handling and deterministic
planned targets/command identities remain unchanged. All unexpired IDs survive
settlement and service recreation; expiry remains the only production deletion
path. No purge or automatic mutation replay is introduced.

## Qualification and operational limits

Related tests cover accumulated settled history alongside new admission,
retained IDs/results and conflicts, unresolved saturation, migration backfill,
UTF-8 charges, atomic rollback, direct SQL replacement refusal, bounded expiry
and read-only diagnostics. Native SQLite is the accounting boundary; tests use
only their owned databases. MCP server and authenticated HTTP tests retain the
existing ownership and lost-acknowledgement proof.

A rebuilt bundle does not change an already-running backend. The migration and
new policy apply when that code next opens its database through ordinary startup.
No runtime restart, live database mutation or live-provider adoption is implied.
