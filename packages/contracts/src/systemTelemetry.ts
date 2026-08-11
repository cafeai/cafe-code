import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ServerSystemTelemetryPercent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);

const EXACT_TELEMETRY_PERCENT_TOLERANCE = 1e-9;
const ROUNDED_TELEMETRY_PERCENT_TOLERANCE = 1;

function matchesUtilizationPercent(
  usedBytes: number,
  availableBytes: number,
  utilizationPercent: number,
  tolerance: number,
): boolean {
  const denominator = usedBytes + availableBytes;
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    return false;
  }
  return Math.abs(utilizationPercent - (usedBytes / denominator) * 100) <= tolerance;
}

export const ServerSystemCpuTelemetry = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    utilizationPercent: ServerSystemTelemetryPercent,
    logicalProcessorCount: PositiveInt,
    detail: Schema.Null,
  }),
  Schema.Struct({
    status: Schema.Literal("warming"),
    utilizationPercent: Schema.Null,
    logicalProcessorCount: PositiveInt,
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    utilizationPercent: Schema.Null,
    logicalProcessorCount: NonNegativeInt,
    detail: TrimmedNonEmptyString,
  }),
]);
export type ServerSystemCpuTelemetry = typeof ServerSystemCpuTelemetry.Type;

const ServerSystemMemoryTelemetryAvailable = Schema.Struct({
  status: Schema.Literal("available"),
  totalBytes: PositiveInt,
  usedBytes: NonNegativeInt,
  // Runtime-reported memory available to Cafe. Platforms whose runtime
  // cannot distinguish reusable memory from raw free pages report unavailable.
  availableBytes: NonNegativeInt,
  utilizationPercent: ServerSystemTelemetryPercent,
  detail: Schema.Null,
}).check(
  Schema.makeFilter((memory) =>
    Number.isSafeInteger(memory.usedBytes + memory.availableBytes) &&
    memory.usedBytes + memory.availableBytes === memory.totalBytes &&
    matchesUtilizationPercent(
      memory.usedBytes,
      memory.availableBytes,
      memory.utilizationPercent,
      EXACT_TELEMETRY_PERCENT_TOLERANCE,
    )
      ? undefined
      : "memory byte counters and utilization must describe the same process-effective capacity",
  ),
);

export const ServerSystemMemoryTelemetry = Schema.Union([
  ServerSystemMemoryTelemetryAvailable,
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    totalBytes: Schema.Null,
    usedBytes: Schema.Null,
    availableBytes: Schema.Null,
    utilizationPercent: Schema.Null,
    detail: TrimmedNonEmptyString,
  }),
]);
export type ServerSystemMemoryTelemetry = typeof ServerSystemMemoryTelemetry.Type;

const ServerProjectVolumeTelemetryAvailable = Schema.Struct({
  status: Schema.Literal("available"),
  totalBytes: PositiveInt,
  // `usedBytes + availableBytes` can be less than `totalBytes` when the
  // filesystem reserves blocks. `utilizationPercent` follows `df` Use%:
  // used / (used + process-available), not used / total.
  usedBytes: NonNegativeInt,
  // Available capacity on the volume containing the selected project only.
  availableBytes: NonNegativeInt,
  utilizationPercent: ServerSystemTelemetryPercent,
  projectVolumeOnly: Schema.Literal(true),
  detail: Schema.Null,
}).check(
  Schema.makeFilter((volume) => {
    const addressableBytes = volume.usedBytes + volume.availableBytes;
    return Number.isSafeInteger(addressableBytes) &&
      addressableBytes > 0 &&
      addressableBytes <= volume.totalBytes &&
      matchesUtilizationPercent(
        volume.usedBytes,
        volume.availableBytes,
        volume.utilizationPercent,
        ROUNDED_TELEMETRY_PERCENT_TOLERANCE,
      )
      ? undefined
      : "project-volume byte counters and utilization must describe the same addressable capacity";
  }),
);

export const ServerProjectVolumeTelemetry = Schema.Union([
  ServerProjectVolumeTelemetryAvailable,
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    totalBytes: Schema.Null,
    usedBytes: Schema.Null,
    availableBytes: Schema.Null,
    utilizationPercent: Schema.Null,
    projectVolumeOnly: Schema.Literal(true),
    detail: TrimmedNonEmptyString,
  }),
]);
export type ServerProjectVolumeTelemetry = typeof ServerProjectVolumeTelemetry.Type;

export const ServerProjectSystemTelemetryResult = Schema.Struct({
  projectId: ProjectId,
  sampledAt: Schema.DateTimeUtc,
  minimumSampleIntervalMs: PositiveInt,
  platform: TrimmedNonEmptyString,
  architecture: TrimmedNonEmptyString,
  cpu: ServerSystemCpuTelemetry,
  memory: ServerSystemMemoryTelemetry,
  projectVolume: ServerProjectVolumeTelemetry,
});
export type ServerProjectSystemTelemetryResult = typeof ServerProjectSystemTelemetryResult.Type;
