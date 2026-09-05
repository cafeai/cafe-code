/**
 * Process-local progress for the provider-daemon -> backend ingestion lane.
 *
 * The durable projection cursor is intentionally written only once per batch so
 * token-heavy provider streams do not add one SQLite write per runtime event.
 * Runtime diagnostics, however, must describe events that have actually passed
 * through ingestion rather than the older crash-recovery checkpoint. Keeping
 * this monotonic, payload-free cursor in memory gives diagnostics that live view
 * without adding work to the persistence hot path.
 */
let latestProcessedCursor = 0;

export function recordProviderRuntimeIngestionCursor(cursor: number): void {
  if (!Number.isFinite(cursor)) return;
  latestProcessedCursor = Math.max(latestProcessedCursor, Math.max(0, Math.trunc(cursor)));
}

export function readProviderRuntimeIngestionCursor(): number {
  return latestProcessedCursor;
}

/** Test-only reset. Production ingestion progress must remain monotonic. */
export function resetProviderRuntimeIngestionCursorForTest(): void {
  latestProcessedCursor = 0;
}
