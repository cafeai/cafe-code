import type { ServerProjectVolumeTelemetry } from "@cafecode/contracts";

const PROJECT_VOLUME_UNAVAILABLE_DETAIL = "Project-volume telemetry is unavailable.";

export interface ProjectVolumeCounters {
  /** Byte multiplier shared by the blocks, freeBlocks, and availableBlocks sample. */
  readonly blockSize: bigint;
  readonly blocks: bigint;
  readonly freeBlocks: bigint;
  readonly availableBlocks: bigint;
}

export interface ProjectVolumeReader {
  /**
   * Read counters for the server-authoritative workspace root.
   *
   * Implementations must run the native read inside an independently
   * terminable owner, apply `timeoutMs` as the functional deadline, and begin
   * terminating that owner when the deadline expires. The returned promise
   * must reject with a fixed path-free error only after the owner releases its
   * native resources. An OS-level uninterruptible filesystem operation can
   * therefore keep this promise pending; bounded callers must race their own
   * non-destructive watchdog without treating waiter timeout as ownership
   * release. Raw paths and filesystem error text must never cross a
   * caller-visible boundary.
   */
  readonly read: (workspaceRoot: string, timeoutMs: number) => Promise<ProjectVolumeCounters>;
}

function boundedPercent(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function bigintToSafeBytes(value: bigint): number | null {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function hasBigIntCounterFields(value: unknown): value is ProjectVolumeCounters {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<keyof ProjectVolumeCounters, unknown>;
  return (
    typeof candidate.blockSize === "bigint" &&
    typeof candidate.blocks === "bigint" &&
    typeof candidate.freeBlocks === "bigint" &&
    typeof candidate.availableBlocks === "bigint"
  );
}

export function projectVolumeMetricFromCounters(
  counters: ProjectVolumeCounters,
): ServerProjectVolumeTelemetry {
  if (
    !hasBigIntCounterFields(counters) ||
    counters.blockSize <= 0n ||
    counters.blocks <= 0n ||
    counters.freeBlocks < 0n ||
    counters.availableBlocks < 0n ||
    counters.freeBlocks > counters.blocks ||
    counters.availableBlocks > counters.freeBlocks ||
    counters.availableBlocks > counters.blocks
  ) {
    return unavailableProjectVolumeTelemetry();
  }
  const totalBytes = bigintToSafeBytes(counters.blockSize * counters.blocks);
  const freeBytes = bigintToSafeBytes(counters.blockSize * counters.freeBlocks);
  const availableBytes = bigintToSafeBytes(counters.blockSize * counters.availableBlocks);
  if (
    totalBytes === null ||
    freeBytes === null ||
    availableBytes === null ||
    totalBytes <= 0 ||
    freeBytes > totalBytes ||
    availableBytes > totalBytes
  ) {
    return unavailableProjectVolumeTelemetry();
  }

  // Match `df`: `bfree` determines blocks consumed by data, while `bavail`
  // excludes filesystem-reserved blocks when the platform has them and is
  // what this process can allocate. Windows normally reports both equally.
  const usedBytes = totalBytes - freeBytes;
  const utilizationPercent = boundedPercent(usedBytes, usedBytes + availableBytes);
  if (utilizationPercent === null) {
    return unavailableProjectVolumeTelemetry();
  }
  return {
    status: "available",
    totalBytes,
    usedBytes,
    availableBytes,
    utilizationPercent,
    projectVolumeOnly: true,
    detail: null,
  };
}

export function unavailableProjectVolumeTelemetry(): ServerProjectVolumeTelemetry {
  return {
    status: "unavailable",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    utilizationPercent: null,
    projectVolumeOnly: true,
    detail: PROJECT_VOLUME_UNAVAILABLE_DETAIL,
  };
}
