/**
 * A private inherited pipe, never stdout or a network endpoint, carries this
 * tiny protocol from the exact backend child to its desktop owner. It contains
 * only a migration number and lifecycle phase: no SQL, paths, errors or tokens.
 */
export const BACKEND_STARTUP_PROGRESS_FD = 4;
export const BACKEND_MIGRATION_STARTUP_BUDGET_MS = 10 * 60 * 1_000;
// Large inherited stores can legitimately spend tens of minutes in the shipped
// transactional backfill. Daemon startup has one longer, still absolute cap;
// ordinary/no-progress startup and the main backend retain their prior bounds.
export const PROVIDER_DAEMON_MIGRATION_STARTUP_BUDGET_MS = 60 * 60 * 1_000;
const MAX_PROGRESS_LINE_BYTES = 96;
const MAX_PROGRESS_BYTES = 64 * 1_024;
const MAX_PROGRESS_RECORDS = 2_048;

export interface BackendMigrationProgress {
  readonly phase: "start" | "complete" | "failed";
  readonly migrationId: number;
}

/** Sanitized desktop feedback; never includes paths, SQL or child output. */
export interface ProviderDaemonStartupProgress {
  readonly phase: "starting" | "migrating" | "ready" | "failed";
  readonly migrationId?: number;
}

export function encodeBackendMigrationProgress(record: BackendMigrationProgress): string {
  return `cafe-migration:v1:${record.phase}:${record.migrationId}\n`;
}

/** Decode incrementally without retaining arbitrary child output or Unicode. */
export function makeBackendMigrationProgressDecoder() {
  let pending = "";
  let totalBytes = 0;
  let recordCount = 0;
  let invalid = false;
  return {
    push(bytes: Uint8Array): {
      readonly records: ReadonlyArray<BackendMigrationProgress>;
      readonly invalid: boolean;
    } {
      const records: BackendMigrationProgress[] = [];
      totalBytes += bytes.byteLength;
      if (invalid || totalBytes > MAX_PROGRESS_BYTES) {
        invalid = true;
        pending = "";
        return { records, invalid };
      }
      for (const byte of bytes) {
        if (byte === 10) {
          const match = /^cafe-migration:v1:(start|complete|failed):([1-9][0-9]{0,4})$/.exec(
            pending,
          );
          pending = "";
          recordCount += 1;
          if (!match || recordCount > MAX_PROGRESS_RECORDS) {
            invalid = true;
            break;
          }
          records.push({
            phase: match[1] as BackendMigrationProgress["phase"],
            migrationId: Number(match[2]),
          });
        } else if (byte < 32 || byte > 126 || pending.length >= MAX_PROGRESS_LINE_BYTES) {
          invalid = true;
          break;
        } else {
          pending += String.fromCharCode(byte);
        }
      }
      if (invalid) pending = "";
      return { records: invalid ? [] : records, invalid };
    },
    end(): boolean {
      return invalid || pending.length > 0;
    },
  };
}

/**
 * Deadlines are elapsed monotonic milliseconds from the child's spawn, not
 * lease renewals. A valid migration start grants one configured absolute cap.
 * Completion restores the ordinary startup window, still inside that cap.
 * Duplicate frames, retries and later migration starts cannot renew the cap.
 */
export function makeBackendStartupDeadline(
  ordinaryTimeoutMs: number,
  migrationBudgetMs = BACKEND_MIGRATION_STARTUP_BUDGET_MS,
) {
  let deadlineMs = ordinaryTimeoutMs;
  let migrationId: number | undefined;
  let finished = false;
  let invalid = false;
  return {
    get deadlineMs(): number {
      return deadlineMs;
    },
    get activeMigrationId(): number | undefined {
      return migrationId;
    },
    observe(record: BackendMigrationProgress, elapsedMs: number): boolean {
      if (finished || invalid || elapsedMs >= deadlineMs) return false;
      if (record.phase === "start") {
        if (migrationId !== undefined && record.migrationId < migrationId) {
          this.invalidate();
          return false;
        }
        // Effect commits all pending migrations together. Increasing starts
        // update the observed phase without closing its transaction allowance;
        // only the runner's post-commit terminal record ends this phase.
        migrationId = record.migrationId;
        deadlineMs = migrationBudgetMs;
      } else if (migrationId === record.migrationId) {
        migrationId = undefined;
        deadlineMs = Math.min(migrationBudgetMs, elapsedMs + ordinaryTimeoutMs);
      } else {
        this.invalidate();
        return false;
      }
      return true;
    },
    invalidate(): void {
      if (finished) return;
      invalid = true;
      migrationId = undefined;
      deadlineMs = Math.min(deadlineMs, ordinaryTimeoutMs);
    },
    finish(): void {
      finished = true;
      migrationId = undefined;
    },
  };
}

/**
 * One exact-owned daemon attempt consumes its inherited progress bytes here.
 * Callers measure elapsed time monotonically from BEFORE spawn; the tracker is
 * not transferable to an adopted PID or another bootstrap generation. The UI
 * receives only accepted lifecycle phases and a validated numeric migration.
 */
export function makeProviderDaemonStartupProgressTracker(
  ordinaryTimeoutMs: number,
  report?: (progress: ProviderDaemonStartupProgress) => void,
) {
  const deadline = makeBackendStartupDeadline(
    ordinaryTimeoutMs,
    PROVIDER_DAEMON_MIGRATION_STARTUP_BUDGET_MS,
  );
  const decoder = makeBackendMigrationProgressDecoder();
  let finished = false;
  let lastPhase: ProviderDaemonStartupProgress | undefined;
  const publish = (progress: ProviderDaemonStartupProgress) => {
    if (lastPhase?.phase === progress.phase && lastPhase.migrationId === progress.migrationId)
      return;
    lastPhase = progress;
    report?.(progress);
  };
  return {
    get deadlineMs(): number {
      return deadline.deadlineMs;
    },
    start(): void {
      if (!finished) publish({ phase: "starting" });
    },
    invalidate(): void {
      if (finished) return;
      deadline.invalidate();
      publish({ phase: "starting" });
    },
    push(bytes: Uint8Array, elapsedMs: number): void {
      if (finished) return;
      const decoded = decoder.push(bytes);
      if (decoded.invalid) {
        deadline.invalidate();
        publish({ phase: "starting" });
        return;
      }
      for (const record of decoded.records) {
        if (!deadline.observe(record, elapsedMs)) continue;
        publish(
          record.phase === "start"
            ? { phase: "migrating", migrationId: record.migrationId }
            : { phase: "starting" },
        );
      }
    },
    end(): void {
      if (finished) return;
      if (decoder.end()) {
        deadline.invalidate();
        publish({ phase: "starting" });
      }
    },
    finish(phase: "ready" | "failed"): void {
      if (finished) return;
      finished = true;
      deadline.finish();
      publish({ phase });
    },
  };
}
