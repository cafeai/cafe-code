import type { ServerProjectSystemTelemetryResult } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";

export const PROJECT_TELEMETRY_HISTORY_LIMIT = 48;

export interface ProjectTelemetryHistoryPoint {
  readonly sampledAtMs: number;
  readonly cpuPercent: number | null;
  readonly memoryPercent: number | null;
  readonly projectVolumePercent: number | null;
  readonly gpuPercent: number | null;
  readonly vramPercent: number | null;
}

export interface ProjectTelemetryGpuProjection {
  readonly gpuPercent: number | null;
  readonly gpuDetail: string;
  readonly vramPercent: number | null;
  readonly vramUsedBytes: number | null;
  readonly vramAvailableBytes: number | null;
  readonly vramDetail: string;
}

export type ProjectTelemetryGpuAdapter = (
  telemetry: ServerProjectSystemTelemetryResult,
) => ProjectTelemetryGpuProjection;

const unavailableGpuProjection = (): ProjectTelemetryGpuProjection => ({
  gpuPercent: null,
  gpuDetail: "GPU utilization is unavailable from this backend.",
  vramPercent: null,
  vramUsedBytes: null,
  vramAvailableBytes: null,
  vramDetail: "GPU memory telemetry is unavailable from this backend.",
});

function finitePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readDetail(record: Record<string, unknown>, fallback: string): string {
  return typeof record.detail === "string" && record.detail.trim().length > 0
    ? record.detail
    : fallback;
}

/**
 * Compatibility seam for the GPU adapter PR. The base telemetry contract has
 * no GPU field, so this returns an explicit unavailable projection today. Once
 * the RPC grows a `gpu` object, this consumes its bounded utilization and
 * memory fields without changing the graph or its polling lifecycle.
 */
export const projectTelemetryGpuAdapter: ProjectTelemetryGpuAdapter = (telemetry) => {
  const gpu = (telemetry as unknown as { readonly gpu?: unknown }).gpu;
  if (!gpu || typeof gpu !== "object") {
    return unavailableGpuProjection();
  }

  const gpuRecord = gpu as Record<string, unknown>;
  const detail = readDetail(gpuRecord, "GPU telemetry is unavailable.");
  const unavailable = { ...unavailableGpuProjection(), gpuDetail: detail, vramDetail: detail };
  const adapters = gpuRecord.adapters;
  if (
    gpuRecord.status !== "available" ||
    !Array.isArray(adapters) ||
    adapters.length === 0 ||
    adapters.length > 64
  ) {
    return unavailable;
  }

  let gpuPercent = 0;
  let vramUsedBytes = 0;
  let vramTotalBytes = 0;
  let vramAvailable = true;
  for (const adapter of adapters) {
    if (!adapter || typeof adapter !== "object") return unavailable;
    const record = adapter as Record<string, unknown>;
    const utilization = finitePercent(record.utilizationPercent);
    if (utilization === null) return unavailable;
    gpuPercent = Math.max(gpuPercent, utilization);
    const memoryPercent = finitePercent(record.memoryUtilizationPercent);
    const memoryTotal = finiteNonNegativeInteger(record.memoryTotalBytes);
    const memoryUsed = finiteNonNegativeInteger(record.memoryUsedBytes);
    if (
      memoryPercent === null ||
      memoryTotal === null ||
      memoryTotal === 0 ||
      memoryUsed === null ||
      memoryUsed > memoryTotal
    ) {
      vramAvailable = false;
      continue;
    }
    vramUsedBytes += memoryUsed;
    vramTotalBytes += memoryTotal;
  }
  const adapterLabel = `${adapters.length} GPU adapter${adapters.length === 1 ? "" : "s"}`;
  const gpuProjection = { ...unavailable, gpuPercent, gpuDetail: `Peak across ${adapterLabel}` };
  if (
    !vramAvailable ||
    !Number.isSafeInteger(vramUsedBytes) ||
    !Number.isSafeInteger(vramTotalBytes)
  ) {
    return gpuProjection;
  }

  return {
    ...gpuProjection,
    vramPercent: (vramUsedBytes / vramTotalBytes) * 100,
    vramUsedBytes,
    vramAvailableBytes: vramTotalBytes - vramUsedBytes,
    vramDetail: `Combined ${adapterLabel} memory`,
  };
};

export function toProjectTelemetryHistoryPoint(
  telemetry: ServerProjectSystemTelemetryResult,
  gpu: ProjectTelemetryGpuProjection,
): ProjectTelemetryHistoryPoint {
  return {
    sampledAtMs: DateTime.toEpochMillis(telemetry.sampledAt),
    cpuPercent: telemetry.cpu.status === "available" ? telemetry.cpu.utilizationPercent : null,
    memoryPercent:
      telemetry.memory.status === "available" ? telemetry.memory.utilizationPercent : null,
    projectVolumePercent:
      telemetry.projectVolume.status === "available"
        ? telemetry.projectVolume.utilizationPercent
        : null,
    gpuPercent: gpu.gpuPercent,
    vramPercent: gpu.vramPercent,
  };
}

export function appendBoundedTelemetryHistory(
  history: readonly ProjectTelemetryHistoryPoint[],
  point: ProjectTelemetryHistoryPoint,
  limit = PROJECT_TELEMETRY_HISTORY_LIMIT,
): readonly ProjectTelemetryHistoryPoint[] {
  const boundedLimit =
    limit === Number.POSITIVE_INFINITY
      ? 120
      : Number.isFinite(limit)
        ? Math.max(1, Math.min(120, Math.trunc(limit)))
        : 1;
  return [...history.slice(Math.max(0, history.length - boundedLimit + 1)), point];
}

export function buildTelemetrySparklinePath(
  values: readonly (number | null)[],
  width = 100,
  height = 24,
): string {
  if (values.length === 0) return "";
  const xStep = values.length === 1 ? 0 : width / (values.length - 1);
  let path = "";
  let drawing = false;

  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      drawing = false;
      return;
    }
    const x = index * xStep;
    const y = height - (Math.max(0, Math.min(100, value)) / 100) * height;
    const point = `${x.toFixed(2)} ${y.toFixed(2)}`;
    path += drawing ? ` L ${point}` : `M ${point} L ${point}`;
    drawing = true;
  });

  return path.trim();
}

export function formatTelemetryBytes(bytes: number | null): string {
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return "Unavailable";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const exponent = Math.max(0, Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1));
  const scaled = bytes / 1024 ** exponent;
  const digits = scaled >= 100 || exponent === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(digits))} ${units[exponent]}`;
}
