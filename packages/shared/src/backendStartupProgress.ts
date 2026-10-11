/**
 * A private inherited pipe, never stdout or a network endpoint, carries this
 * tiny protocol from the exact backend child to its desktop owner. It contains
 * only a migration number and lifecycle phase: no SQL, paths, errors or tokens.
 */
export const BACKEND_STARTUP_PROGRESS_FD = 4;
export const BACKEND_MIGRATION_STARTUP_BUDGET_MS = 10 * 60 * 1_000;
const MAX_PROGRESS_LINE_BYTES = 96;
const MAX_PROGRESS_BYTES = 64 * 1_024;
const MAX_PROGRESS_RECORDS = 2_048;

export interface BackendMigrationProgress {
  readonly phase: "start" | "complete" | "failed";
  readonly migrationId: number;
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
 * lease renewals. A valid migration start grants one absolute ten-minute cap.
 * Completion restores the ordinary startup window, still inside that cap.
 * Duplicate frames, retries and later migration starts cannot renew the cap.
 */
export function makeBackendStartupDeadline(ordinaryTimeoutMs: number) {
  let deadlineMs = ordinaryTimeoutMs;
  let migrationId: number | undefined;
  let finished = false;
  let invalid = false;
  return {
    get deadlineMs(): number {
      return deadlineMs;
    },
    observe(record: BackendMigrationProgress, elapsedMs: number): void {
      if (finished || invalid || elapsedMs >= deadlineMs) return;
      if (record.phase === "start") {
        if (migrationId !== undefined && record.migrationId < migrationId) {
          this.invalidate();
          return;
        }
        // Effect commits all pending migrations together. Increasing starts
        // update the observed phase without closing its transaction allowance;
        // only the runner's post-commit terminal record ends this phase.
        migrationId = record.migrationId;
        deadlineMs = BACKEND_MIGRATION_STARTUP_BUDGET_MS;
      } else if (migrationId === record.migrationId) {
        migrationId = undefined;
        deadlineMs = Math.min(BACKEND_MIGRATION_STARTUP_BUDGET_MS, elapsedMs + ordinaryTimeoutMs);
      } else {
        this.invalidate();
      }
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
