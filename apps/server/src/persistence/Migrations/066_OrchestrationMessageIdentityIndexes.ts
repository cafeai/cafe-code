import * as Effect from "effect/Effect";

/**
 * Retired before broad release.
 *
 * The original migration created JSON expression indexes over the complete
 * append-only event ledger. On a mature Cafe database that turns application
 * startup into a multi-minute, database-wide scan while holding SQLite's sole
 * writer lock. The desktop provider daemon and main backend legitimately open
 * the same database concurrently, so the second process then failed with
 * SQLITE_BUSY and entered a restart loop.
 *
 * Keep migration id 66 as a no-op because migration ids are durable history:
 * reusing or removing it would make already-upgraded databases diverge. The
 * cheap schema-only replacement is migration 68, which records identities at
 * append time and hydrates older identities per thread after readiness.
 */
export default Effect.void;
