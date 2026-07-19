// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalConsoleInEffect:off
// @effect-diagnostics globalTimers:off
import type { DesktopDebugEndpointState, DesktopRendererDebugSnapshot } from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";

const DEBUG_HOST = "127.0.0.1";
const DEBUG_PATH = "/debug";
const DEBUG_SWITCHES = new Set(["--cafe-debug", "--debug"]);
const DEBUG_FULL_DETAIL_PARAM = "full";
const DEBUG_COMPACT_DETAIL_PARAM = "compact";
const RENDERER_SNAPSHOT_HISTORY_LIMIT = 20;
const PROCESS_DIAGNOSTIC_HISTORY_LIMIT = 25;
const EVENT_LOOP_MONITOR_INTERVAL_MS = 1_000;
const PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS = 2_000;
const PROVIDER_DAEMON_DEBUG_REFRESH_TTL_MS = 5_000;
const PROVIDER_TO_RENDERER_DEGRADED_LAG_MS = 30_000;
const PROVIDER_TO_RENDERER_OFFLINE_LAG_MS = 120_000;
const PROCESS_DIAGNOSTIC_MESSAGE_LIMIT = 4_000;
const PROCESS_DIAGNOSTIC_STACK_LIMIT = 16_000;
const COMPACT_STRING_LIMIT = 240;
const COMPACT_ARRAY_LIMIT = 12;
const KNOWN_SLOW_VALIDATION_TARGETS = [
  {
    target: "apps/server/src/git/GitManager.test.ts",
    lastObservedDurationMs: 163_319,
    note: "Slow full-suite target observed during detached-supervisor validation.",
  },
  {
    target: "apps/server/src/orchestration/Layers/CheckpointReactor.test.ts",
    lastObservedDurationMs: 104_792,
    note: "Slow full-suite target observed during detached-supervisor validation.",
  },
  {
    target: "integration/orchestrationEngine.integration.test.ts",
    lastObservedDurationMs: 90_876,
    note: "Slow full-suite target observed during detached-supervisor validation.",
  },
  {
    target: "apps/server/src/vcs/GitVcsDriverCore.test.ts",
    lastObservedDurationMs: 38_629,
    note: "Slow full-suite target observed during detached-supervisor validation.",
  },
  {
    target: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts",
    lastObservedDurationMs: 37_665,
    note: "Slow full-suite target observed during detached-supervisor validation.",
  },
] as const;

interface RendererSnapshotHistoryEntry {
  readonly receivedAt: string;
  readonly capturedAt: string | null;
  readonly source: string | null;
  readonly activeThreadId: string | null;
  readonly sessionStatus: string | null;
  readonly activeTurnId: string | null;
  readonly latestTurnState: string | null;
  readonly latestTurnSettled: boolean | null;
  readonly queueLength: number | null;
  readonly queueBlockers: readonly string[];
  readonly phase: string | null;
  readonly followUpQueuePhase: string | null;
  readonly activeTurnInProgress: boolean | null;
  readonly uiWorking: boolean | null;
  readonly rendererSnapshotBuildDurationMs: number | null;
  readonly activeTurnElapsedMs: number | null;
  readonly lastActivityAgeMs: number | null;
  readonly latestContextWindowUpdatedAt: string | null;
  readonly latestContextInputTokens: number | null;
  readonly latestContextCachedInputTokens: number | null;
  readonly latestContextOutputTokens: number | null;
  readonly activeThreadPressureFlags: readonly string[];
  readonly lifecycleRedFlags: readonly string[];
  readonly queueLifecycleRedFlags: readonly string[];
  readonly latestTimelineScrollSource: string | null;
  readonly latestTimelineScrollReason: string | null;
  readonly latestTimelineScrollCapturedAt: string | null;
  readonly latestTimelineScrollRemainingDistance: number | null;
  readonly latestTimelineScrollRowCount: number | null;
  readonly timelineScrollAutoFollowTail: boolean | null;
  readonly timelineScrollShowScrollToBottom: boolean | null;
}

interface DesktopProcessDiagnostic {
  readonly capturedAt: string;
  readonly kind: "uncaughtException" | "unhandledRejection" | "warning" | "manual";
  readonly origin: string | null;
  readonly tag: string;
  readonly message: string;
  readonly name: string | null;
  readonly stack: string | null;
}

interface DebugServerRuntimeState {
  readonly enabled: boolean;
  readonly launchedAt: string;
  startedAt: string | null;
  url: string | null;
  server: NodeHttp.Server | null;
  requestsServed: number;
  lastDebugRequestAt: string | null;
  lastDebugRequestDurationMs: number | null;
  lastDebugResponseBytes: number | null;
  rendererSnapshot: DesktopRendererDebugSnapshot | null;
  providerDaemonSnapshot: Record<string, unknown> | null;
  providerDaemonSnapshotRefresher: (() => Promise<void>) | null;
  providerDaemonSnapshotRefresh: {
    lastAttemptAt: string | null;
    lastDurationMs: number | null;
    lastError: string | null;
    attemptCount: number;
    failureCount: number;
    inFlight: boolean;
  };
  rendererSnapshotUpdatedAt: string | null;
  rendererSnapshotHistory: RendererSnapshotHistoryEntry[];
  processDiagnostics: {
    listenerInstalled: boolean;
    totalCount: number;
    recent: DesktopProcessDiagnostic[];
  };
  eventLoop: {
    interval: ReturnType<typeof setInterval> | null;
    startedAt: string | null;
    updatedAt: string | null;
    expectedAtMs: number | null;
    lastDelayMs: number | null;
    maxDelayMs: number;
    totalDelayMs: number;
    sampleCount: number;
  };
}

class DesktopDebugServerStartError extends Data.TaggedError("DesktopDebugServerStartError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : "Cafe Code debug server failed to start.";
  }
}

export function isDesktopDebugModeEnabled(argv: readonly string[] = process.argv): boolean {
  return argv.some((arg) => DEBUG_SWITCHES.has(arg));
}

const state: DebugServerRuntimeState = {
  enabled: isDesktopDebugModeEnabled(),
  launchedAt: new Date().toISOString(),
  startedAt: null,
  url: null,
  server: null,
  requestsServed: 0,
  lastDebugRequestAt: null,
  lastDebugRequestDurationMs: null,
  lastDebugResponseBytes: null,
  rendererSnapshot: null,
  providerDaemonSnapshot: null,
  providerDaemonSnapshotRefresher: null,
  providerDaemonSnapshotRefresh: {
    lastAttemptAt: null,
    lastDurationMs: null,
    lastError: null,
    attemptCount: 0,
    failureCount: 0,
    inFlight: false,
  },
  rendererSnapshotUpdatedAt: null,
  rendererSnapshotHistory: [],
  processDiagnostics: {
    listenerInstalled: false,
    totalCount: 0,
    recent: [],
  },
  eventLoop: {
    interval: null,
    startedAt: null,
    updatedAt: null,
    expectedAtMs: null,
    lastDelayMs: null,
    maxDelayMs: 0,
    totalDelayMs: 0,
    sampleCount: 0,
  },
};

function isAddressInfo(
  address: NodeNet.AddressInfo | string | null,
): address is NodeNet.AddressInfo {
  return typeof address === "object" && address !== null && typeof address.port === "number";
}

function writeJson(
  response: NodeHttp.ServerResponse,
  statusCode: number,
  body: unknown,
  options: { readonly pretty?: boolean } = {},
): number {
  const responseBody = `${JSON.stringify(body, null, options.pretty === true ? 2 : undefined)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(responseBody);
  return Buffer.byteLength(responseBody, "utf8");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function estimateJsonBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? Buffer.byteLength(json, "utf8") : null;
  } catch {
    return null;
  }
}

function isFullDebugRequest(url: URL): boolean {
  const detail = url.searchParams.get("detail");
  return (
    detail === DEBUG_FULL_DETAIL_PARAM ||
    url.searchParams.get(DEBUG_FULL_DETAIL_PARAM) === "1" ||
    url.searchParams.get(DEBUG_FULL_DETAIL_PARAM) === "true"
  );
}

function readTimestampAgeMs(value: unknown, nowMs: number = Date.now()): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

function readIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function maxIsoTimestamp(...values: ReadonlyArray<unknown>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = readIsoTimestamp(value);
    if (timestamp === null) {
      continue;
    }
    const timestampMs = Date.parse(timestamp);
    if (timestampMs > bestMs) {
      best = timestamp;
      bestMs = timestampMs;
    }
  }
  return best;
}

function compactString(value: string, maxLength = COMPACT_STRING_LIMIT): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function compactPath(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return value ?? null;
  }
  const normalized = NodePath.normalize(value);
  return {
    basename: NodePath.basename(normalized),
    parentBasename: NodePath.basename(NodePath.dirname(normalized)),
  };
}

function compactStringArray(value: unknown, limit = COMPACT_ARRAY_LIMIT): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, limit)
    .map((entry) => compactString(entry));
}

function compactCountedArray(value: unknown, limit = COMPACT_ARRAY_LIMIT): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {
      count: 0,
      items: [],
      omitted: 0,
    };
  }
  return {
    count: value.length,
    items: value.slice(0, limit),
    omitted: Math.max(0, value.length - limit),
  };
}

function roundDebugMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateDiagnosticText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...<truncated>`;
}

function readErrorRecord(error: unknown): Record<string, unknown> | null {
  return error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
}

function processDiagnosticString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordDesktopProcessDiagnostic(
  kind: DesktopProcessDiagnostic["kind"],
  error: unknown,
  origin: string | null = null,
): void {
  const record = readErrorRecord(error);
  const name =
    error instanceof Error && error.name.length > 0
      ? error.name
      : processDiagnosticString(record?.name);
  const tag = processDiagnosticString(record?._tag) ?? name ?? typeof error;
  const message = truncateDiagnosticText(errorMessage(error), PROCESS_DIAGNOSTIC_MESSAGE_LIMIT);
  const stack =
    error instanceof Error
      ? error.stack
      : (processDiagnosticString(record?.stack) ?? processDiagnosticString(record?.trace));

  state.processDiagnostics.totalCount += 1;
  state.processDiagnostics.recent.push({
    capturedAt: new Date().toISOString(),
    kind,
    origin,
    tag,
    message,
    name,
    stack:
      stack === undefined || stack === null
        ? null
        : truncateDiagnosticText(stack, PROCESS_DIAGNOSTIC_STACK_LIMIT),
  });
  if (state.processDiagnostics.recent.length > PROCESS_DIAGNOSTIC_HISTORY_LIMIT) {
    state.processDiagnostics.recent.splice(
      0,
      state.processDiagnostics.recent.length - PROCESS_DIAGNOSTIC_HISTORY_LIMIT,
    );
  }
}

function installDesktopProcessDiagnosticListeners(): void {
  if (state.processDiagnostics.listenerInstalled) {
    return;
  }
  state.processDiagnostics.listenerInstalled = true;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    recordDesktopProcessDiagnostic("uncaughtException", error, origin);
  });
  process.on("unhandledRejection", (reason) => {
    recordDesktopProcessDiagnostic("unhandledRejection", reason);
  });
  process.on("warning", (warning) => {
    recordDesktopProcessDiagnostic("warning", warning, warning.name);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function refreshProviderDaemonSnapshotForDebugRequest(): Promise<void> {
  const refresher = state.providerDaemonSnapshotRefresher;
  if (refresher === null || state.providerDaemonSnapshotRefresh.inFlight) {
    return;
  }

  const refreshStartedAtMs = nodePerformance.now();
  state.providerDaemonSnapshotRefresh.inFlight = true;
  state.providerDaemonSnapshotRefresh.lastAttemptAt = new Date().toISOString();
  state.providerDaemonSnapshotRefresh.attemptCount += 1;
  try {
    await withTimeout(
      refresher(),
      PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS,
      `Provider daemon debug snapshot refresh exceeded ${PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS}ms.`,
    );
    state.providerDaemonSnapshotRefresh.lastDurationMs = roundDebugMs(
      nodePerformance.now() - refreshStartedAtMs,
    );
    state.providerDaemonSnapshotRefresh.lastError = null;
  } catch (error) {
    state.providerDaemonSnapshotRefresh.lastDurationMs = roundDebugMs(
      nodePerformance.now() - refreshStartedAtMs,
    );
    state.providerDaemonSnapshotRefresh.lastError = errorMessage(error);
    state.providerDaemonSnapshotRefresh.failureCount += 1;
  } finally {
    state.providerDaemonSnapshotRefresh.inFlight = false;
  }
}

function providerDaemonSnapshotAgeMs(nowMs: number = Date.now()): number | null {
  const snapshot = readRecord(state.providerDaemonSnapshot);
  return readTimestampAgeMs(snapshot?.updatedAt, nowMs);
}

async function prepareProviderDaemonSnapshotForDebugRequest(fullDetail: boolean): Promise<void> {
  if (state.providerDaemonSnapshotRefresher === null) {
    return;
  }

  const ageMs = providerDaemonSnapshotAgeMs();
  if (fullDetail || state.providerDaemonSnapshot === null) {
    await refreshProviderDaemonSnapshotForDebugRequest();
    return;
  }

  if (ageMs !== null && ageMs <= PROVIDER_DAEMON_DEBUG_REFRESH_TTL_MS) {
    return;
  }

  // Long-running debug sessions should not block ordinary `/debug` reads on a slow daemon
  // health refresh. Return the most recent bounded snapshot immediately and refresh in the
  // background; explicit full-detail requests still await a fresh daemon snapshot above.
  void refreshProviderDaemonSnapshotForDebugRequest();
}

function readEventLoopSnapshot(): Record<string, unknown> {
  const sampleCount = state.eventLoop.sampleCount;
  return {
    intervalMs: EVENT_LOOP_MONITOR_INTERVAL_MS,
    startedAt: state.eventLoop.startedAt,
    updatedAt: state.eventLoop.updatedAt,
    sampleCount,
    lastDelayMs: state.eventLoop.lastDelayMs,
    maxDelayMs: roundDebugMs(state.eventLoop.maxDelayMs),
    meanDelayMs:
      sampleCount === 0 ? null : roundDebugMs(state.eventLoop.totalDelayMs / sampleCount),
  };
}

function startEventLoopMonitor(): void {
  if (state.eventLoop.interval !== null) {
    return;
  }

  const startedAtMs = Date.now();
  state.eventLoop.startedAt = new Date(startedAtMs).toISOString();
  state.eventLoop.updatedAt = null;
  state.eventLoop.expectedAtMs = startedAtMs + EVENT_LOOP_MONITOR_INTERVAL_MS;
  state.eventLoop.lastDelayMs = null;
  state.eventLoop.maxDelayMs = 0;
  state.eventLoop.totalDelayMs = 0;
  state.eventLoop.sampleCount = 0;

  const interval = setInterval(() => {
    const nowMs = Date.now();
    const expectedAtMs = state.eventLoop.expectedAtMs ?? nowMs;
    const delayMs = Math.max(0, nowMs - expectedAtMs);
    state.eventLoop.expectedAtMs = nowMs + EVENT_LOOP_MONITOR_INTERVAL_MS;
    state.eventLoop.updatedAt = new Date(nowMs).toISOString();
    state.eventLoop.lastDelayMs = roundDebugMs(delayMs);
    state.eventLoop.maxDelayMs = Math.max(state.eventLoop.maxDelayMs, delayMs);
    state.eventLoop.totalDelayMs += delayMs;
    state.eventLoop.sampleCount += 1;
  }, EVENT_LOOP_MONITOR_INTERVAL_MS);

  (interval as { unref?: () => void }).unref?.();
  state.eventLoop.interval = interval;
}

function stopEventLoopMonitor(): void {
  if (state.eventLoop.interval === null) {
    return;
  }
  clearInterval(state.eventLoop.interval);
  state.eventLoop.interval = null;
  state.eventLoop.expectedAtMs = null;
}

function buildRendererSnapshotHistoryEntry(
  snapshot: DesktopRendererDebugSnapshot,
  receivedAt: string,
): RendererSnapshotHistoryEntry {
  const route = readRecord(snapshot.route);
  const thread = readRecord(snapshot.thread);
  const session = readRecord(thread?.session);
  const latestTurn = readRecord(thread?.latestTurn);
  const queue = readRecord(snapshot.queue);
  const gates = readRecord(snapshot.gates);
  const lifecycle = readRecord(snapshot.lifecycle);
  const activeLifecycle = readRecord(lifecycle?.active);
  const queueCoupling = readRecord(lifecycle?.queueCoupling);
  const rendererPerformance = readRecord(snapshot.performance);
  const activeThreadPerformance = readRecord(rendererPerformance?.activeThread);
  const activeThreadLatency = readRecord(activeThreadPerformance?.latency);
  const latestContextWindowActivity = readRecord(
    activeThreadPerformance?.latestContextWindowActivity,
  );
  const latestContextWindowUsage = readRecord(latestContextWindowActivity?.usage);
  const timelineScroll = readRecord(snapshot.timelineScroll);
  const latestTimelineScroll = readRecord(timelineScroll?.latest);
  const latestTimelineScrollMetrics = readRecord(latestTimelineScroll?.metrics);
  const timelineScrollState = readRecord(timelineScroll?.state);

  return {
    receivedAt,
    capturedAt: readString(snapshot.capturedAt),
    source: readString(snapshot.source),
    activeThreadId: readString(route?.activeThreadId),
    sessionStatus: readString(session?.status),
    activeTurnId: readString(session?.activeTurnId),
    latestTurnState: readString(latestTurn?.state),
    latestTurnSettled: readBoolean(activeLifecycle?.latestTurnSettled),
    queueLength: readNumber(queue?.length),
    queueBlockers: readStringArray(queue?.blockers),
    phase: readString(gates?.phase),
    followUpQueuePhase: readString(gates?.followUpQueuePhase),
    activeTurnInProgress: readBoolean(queueCoupling?.activeTurnInProgress),
    uiWorking: readBoolean(queueCoupling?.uiWorking),
    rendererSnapshotBuildDurationMs: readNumber(
      rendererPerformance?.rendererSnapshotBuildDurationMs,
    ),
    activeTurnElapsedMs: readNumber(activeThreadLatency?.activeTurnElapsedMs),
    lastActivityAgeMs: readNumber(activeThreadLatency?.lastActivityAgeMs),
    latestContextWindowUpdatedAt: readString(latestContextWindowActivity?.createdAt),
    latestContextInputTokens:
      readNumber(latestContextWindowUsage?.lastInputTokens) ??
      readNumber(latestContextWindowUsage?.inputTokens),
    latestContextCachedInputTokens:
      readNumber(latestContextWindowUsage?.lastCachedInputTokens) ??
      readNumber(latestContextWindowUsage?.cachedInputTokens),
    latestContextOutputTokens:
      readNumber(latestContextWindowUsage?.lastOutputTokens) ??
      readNumber(latestContextWindowUsage?.outputTokens),
    activeThreadPressureFlags: readStringArray(activeThreadPerformance?.pressureFlags),
    lifecycleRedFlags: readStringArray(activeLifecycle?.redFlags),
    queueLifecycleRedFlags: readStringArray(queueCoupling?.redFlags),
    latestTimelineScrollSource: readString(latestTimelineScroll?.source),
    latestTimelineScrollReason: readString(latestTimelineScroll?.reason),
    latestTimelineScrollCapturedAt: readString(latestTimelineScroll?.capturedAt),
    latestTimelineScrollRemainingDistance: readNumber(
      latestTimelineScrollMetrics?.remainingScrollDistance,
    ),
    latestTimelineScrollRowCount: readNumber(latestTimelineScrollMetrics?.rowCount),
    timelineScrollAutoFollowTail: readBoolean(timelineScrollState?.autoFollowTail),
    timelineScrollShowScrollToBottom: readBoolean(timelineScrollState?.showScrollToBottom),
  };
}

function summarizeProcessForCompactDebug(): Record<string, unknown> {
  const memoryUsage = process.memoryUsage();
  const resourceUsage = process.resourceUsage();
  return {
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: roundDebugMs(process.uptime()),
    cwd: compactPath(process.cwd()),
    execPath: compactPath(process.execPath),
    argv: process.argv.filter((arg) => DEBUG_SWITCHES.has(arg)),
    memoryUsage: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
    },
    resourceUsage: {
      userCPUTime: resourceUsage.userCPUTime,
      systemCPUTime: resourceUsage.systemCPUTime,
      maxRSS: resourceUsage.maxRSS,
      fsRead: resourceUsage.fsRead,
      fsWrite: resourceUsage.fsWrite,
    },
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
    },
    diagnostics: {
      listenerInstalled: state.processDiagnostics.listenerInstalled,
      totalCount: state.processDiagnostics.totalCount,
      recentLimit: PROCESS_DIAGNOSTIC_HISTORY_LIMIT,
      recent: state.processDiagnostics.recent.slice(-5).map((entry) => ({
        capturedAt: entry.capturedAt,
        kind: entry.kind,
        origin: entry.origin,
        tag: compactString(entry.tag),
        message: compactString(entry.message),
        name: entry.name,
        hasStack: entry.stack !== null,
      })),
    },
  };
}

function summarizeProviderDaemonHealthForCompactDebug(
  value: unknown,
): Record<string, unknown> | null {
  const health = readRecord(value);
  if (health === null) {
    return null;
  }
  const runtimeEvents = readRecord(health.runtimeEvents);
  const rpc = readRecord(health.rpc);
  const supervisor = readRecord(health.supervisor);
  const supervisorProcess = readRecord(health.supervisorProcess);
  const processDiagnostics = readRecord(health.processDiagnostics);

  return {
    ok: readBoolean(health.ok),
    mode: readString(health.mode),
    protocolVersion: readNumber(health.protocolVersion),
    pid: readNumber(health.pid),
    ppid: readNumber(health.ppid),
    version: readString(health.version),
    runtimeBuildId: readString(health.runtimeBuildId),
    startedAt: readString(health.startedAt),
    activeSessionCount: readNumber(health.activeSessionCount),
    configuredInstanceCount: readNumber(health.configuredInstanceCount),
    activeStreamCount: readNumber(health.activeStreamCount),
    retainedEventCount: readNumber(health.retainedEventCount),
    eventCursor: readNumber(health.eventCursor),
    oldestEventCursor: readNumber(health.oldestEventCursor),
    newestEventCursor: readNumber(health.newestEventCursor),
    commandCount: readNumber(health.commandCount),
    completedCommandCount: readNumber(health.completedCommandCount),
    failedCommandCount: readNumber(health.failedCommandCount),
    runningCommandCount: readNumber(health.runningCommandCount),
    rpc:
      rpc === null
        ? null
        : {
            totalRpcCount: readNumber(rpc.totalRpcCount),
            mutatingRpcCount: readNumber(rpc.mutatingRpcCount),
            failedRpcCount: readNumber(rpc.failedRpcCount),
            maxRpcDurationMs: readNumber(rpc.maxRpcDurationMs),
            meanRpcDurationMs: readNumber(rpc.meanRpcDurationMs),
            lastRpcMethod: readString(rpc.lastRpcMethod),
            lastRpcAt: readString(rpc.lastRpcAt),
            lastRpcDurationMs: readNumber(rpc.lastRpcDurationMs),
            recentFailureCount: Array.isArray(rpc.recentFailures) ? rpc.recentFailures.length : 0,
          },
    runtimeEvents:
      runtimeEvents === null
        ? null
        : {
            retainedEventCount: readNumber(runtimeEvents.retainedEventCount),
            recentMethodCounts: compactCountedArray(runtimeEvents.recentMethodCounts, 8),
            recentTurnTimingCount: Array.isArray(runtimeEvents.recentTurnTimings)
              ? runtimeEvents.recentTurnTimings.length
              : 0,
            lastEventAt: readString(runtimeEvents.lastEventAt),
            lastThreadId: readString(runtimeEvents.lastThreadId),
            lastTurnId: readString(runtimeEvents.lastTurnId),
          },
    supervisor:
      supervisor === null
        ? null
        : {
            sessionCount: readNumber(supervisor.sessionCount),
            runningSessionCount: readNumber(supervisor.runningSessionCount),
            transferringSessionCount: readNumber(supervisor.transferringSessionCount),
            detachedSessionCount: readNumber(supervisor.detachedSessionCount),
            stoppedSessionCount: readNumber(supervisor.stoppedSessionCount),
            errorSessionCount: readNumber(supervisor.errorSessionCount),
          },
    supervisorProcess:
      supervisorProcess === null
        ? null
        : {
            pid: readNumber(supervisorProcess.pid),
            status: readString(supervisorProcess.status),
            adoptedExistingProcess: readBoolean(supervisorProcess.adoptedExistingProcess),
            durationMs: readNumber(supervisorProcess.durationMs),
            endpointTransport: readString(readRecord(supervisorProcess.endpoint)?.transport),
          },
    processDiagnostics:
      processDiagnostics === null
        ? null
        : {
            totalCount: readNumber(processDiagnostics.totalCount),
            recentCount: Array.isArray(processDiagnostics.recent)
              ? processDiagnostics.recent.length
              : 0,
          },
  };
}

function summarizeProviderDaemonForCompactDebug(): Record<string, unknown> {
  const snapshot = readRecord(state.providerDaemonSnapshot);
  if (snapshot === null) {
    return {
      available: false,
      reason: "Provider daemon manager has not published a snapshot yet.",
    };
  }
  const ageMs = providerDaemonSnapshotAgeMs();
  return {
    available: true,
    status: readString(snapshot.status),
    pid: readNumber(snapshot.pid),
    adoptedExistingProcess: readBoolean(snapshot.adoptedExistingProcess),
    updatedAt: readString(snapshot.updatedAt),
    ageMs,
    stale: ageMs === null ? null : ageMs > PROVIDER_DAEMON_DEBUG_REFRESH_TTL_MS,
    runtimeBuildId: readString(snapshot.runtimeBuildId),
    endpoint: {
      transport: readString(readRecord(snapshot.endpoint)?.transport),
      hasHttpBaseUrl: typeof readRecord(snapshot.endpoint)?.httpBaseUrl === "string",
      hasSocketPath: typeof readRecord(snapshot.endpoint)?.socketPath === "string",
      hasLeaseId: typeof readRecord(snapshot.endpoint)?.leaseId === "string",
    },
    paths: {
      markerPath: compactPath(snapshot.markerPath),
      credentialPath: compactPath(snapshot.credentialPath),
    },
    lastError: readString(snapshot.lastError),
    lastHealth: summarizeProviderDaemonHealthForCompactDebug(snapshot.lastHealth),
    performance: readRecord(snapshot.performance),
  };
}

function compactObjectWithoutContentPreviews(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return compactString(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, COMPACT_ARRAY_LIMIT).map(compactObjectWithoutContentPreviews);
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "textPreview" ||
      key === "promptPreview" ||
      key === "payloadPreview" ||
      key === "promptText" ||
      key === "messages" ||
      key === "recentMessages" ||
      key === "recentActivities" ||
      key === "recentRuntimeEvents" ||
      key === "items" ||
      key === "allQueues" ||
      key === "orphanQueues" ||
      key === "turnDiffSummaries"
    ) {
      result[key] = "[omitted-from-compact-debug]";
      continue;
    }
    result[key] = compactObjectWithoutContentPreviews(entry);
  }
  return result;
}

function summarizeRendererForCompactDebug(): Record<string, unknown> {
  const snapshot = readRecord(state.rendererSnapshot);
  if (snapshot === null) {
    return {
      available: false,
      reason: "No renderer snapshot has been published yet.",
      history: state.rendererSnapshotHistory,
    };
  }

  const route = readRecord(snapshot.route);
  const project = readRecord(snapshot.project);
  const thread = readRecord(snapshot.thread);
  const lifecycle = readRecord(snapshot.lifecycle);
  const performance = readRecord(snapshot.performance);
  const activeThreadPerformance = readRecord(performance?.activeThread);
  const queue = readRecord(snapshot.queue);
  const gates = readRecord(snapshot.gates);
  const provider = readRecord(snapshot.provider);
  const composer = readRecord(snapshot.composer);
  const diagnostics = readRecord(snapshot.diagnostics);
  const timelineScroll = readRecord(snapshot.timelineScroll);

  return {
    available: true,
    debugSnapshotVersion: readNumber(snapshot.debugSnapshotVersion),
    source: readString(snapshot.source),
    capturedAt: readString(snapshot.capturedAt),
    updatedAt: state.rendererSnapshotUpdatedAt,
    ageMs: readTimestampAgeMs(state.rendererSnapshotUpdatedAt),
    diagnostics: {
      visibilityState: readString(diagnostics?.visibilityState),
      hasFocus: readBoolean(diagnostics?.hasFocus),
      online: readBoolean(diagnostics?.online),
      localApi: compactObjectWithoutContentPreviews(diagnostics?.localApi),
    },
    timelineScroll:
      timelineScroll === null
        ? null
        : {
            state: compactObjectWithoutContentPreviews(timelineScroll.state),
            currentListMetrics: compactObjectWithoutContentPreviews(
              timelineScroll.currentListMetrics,
            ),
            latest: compactObjectWithoutContentPreviews(timelineScroll.latest),
            recentCount: Array.isArray(timelineScroll.recent) ? timelineScroll.recent.length : 0,
          },
    route: compactObjectWithoutContentPreviews(route),
    project:
      project === null
        ? null
        : {
            id: readString(project.id),
            name: readString(project.name),
            cwd: compactPath(project.cwd),
          },
    thread:
      thread === null
        ? null
        : {
            id: readString(thread.id),
            title: readString(thread.title),
            projectId: readString(thread.projectId),
            worktreePath: compactPath(thread.worktreePath),
            messageCount: readNumber(thread.messageCount),
            activityCount: readNumber(thread.activityCount),
            session: compactObjectWithoutContentPreviews(thread.session),
            latestTurn: compactObjectWithoutContentPreviews(thread.latestTurn),
            consistency: compactObjectWithoutContentPreviews(thread.consistency),
          },
    performance: {
      rendererSnapshotBuildDurationMs: readNumber(performance?.rendererSnapshotBuildDurationMs),
      capturedAtEpochMs: readNumber(performance?.capturedAtEpochMs),
      activeThread: compactObjectWithoutContentPreviews(activeThreadPerformance),
      storePressure: compactObjectWithoutContentPreviews(performance?.storePressure),
      notableThreadCount: Array.isArray(performance?.notableThreads)
        ? performance.notableThreads.length
        : 0,
      notableThreads: Array.isArray(performance?.notableThreads)
        ? performance.notableThreads
            .slice(0, 5)
            .map((threadValue) => compactObjectWithoutContentPreviews(threadValue))
        : [],
    },
    store: compactObjectWithoutContentPreviews(snapshot.store),
    lifecycle: {
      active: compactObjectWithoutContentPreviews(lifecycle?.active),
      counts: compactObjectWithoutContentPreviews(lifecycle?.counts),
      queueCoupling: compactObjectWithoutContentPreviews(lifecycle?.queueCoupling),
      localDispatch: compactObjectWithoutContentPreviews(lifecycle?.localDispatch),
      interestingThreadLimit: readNumber(lifecycle?.interestingThreadLimit),
      interestingThreadCount: Array.isArray(lifecycle?.interestingThreads)
        ? lifecycle.interestingThreads.length
        : 0,
      interestingThreads: Array.isArray(lifecycle?.interestingThreads)
        ? lifecycle.interestingThreads
            .slice(0, 5)
            .map((threadValue) => compactObjectWithoutContentPreviews(threadValue))
        : [],
    },
    provider: compactObjectWithoutContentPreviews(provider),
    composer:
      composer === null
        ? null
        : {
            activeThreadId: readString(composer.activeThreadId),
            phase: readString(composer.phase),
            selectedProvider: readString(composer.selectedProvider),
            selectedInstanceId: readString(composer.selectedInstanceId),
            // Model/options are non-secret dispatch metadata. Keep the compact
            // endpoint deliberately narrower than the full composer snapshot:
            // never add prompt/editor/selection DOM content here.
            selectedModelSelection: compactObjectWithoutContentPreviews(
              composer.selectedModelSelection,
            ),
          },
    queue: {
      activeThreadId: readString(queue?.activeThreadId),
      length: readNumber(queue?.length),
      steeringLength: readNumber(queue?.steeringLength),
      firstItemId: readString(queue?.firstItemId),
      firstItemBlockedReason: readString(queue?.firstItemBlockedReason),
      canStartTurn: readBoolean(queue?.canStartTurn),
      blockers: compactStringArray(queue?.blockers),
      dispatchDebug: compactObjectWithoutContentPreviews(queue?.dispatchDebug),
      itemCount: Array.isArray(queue?.items) ? queue.items.length : 0,
    },
    gates: compactObjectWithoutContentPreviews(gates),
    history: state.rendererSnapshotHistory,
  };
}

function statusForProviderToRendererLag(lagMs: number): "online" | "degraded" | "offline" {
  if (lagMs <= PROVIDER_TO_RENDERER_DEGRADED_LAG_MS) {
    return "online";
  }
  if (lagMs <= PROVIDER_TO_RENDERER_OFFLINE_LAG_MS) {
    return "degraded";
  }
  return "offline";
}

function readRendererLatestVisibleTimestamp(snapshot: Record<string, unknown>): string | null {
  const thread = readRecord(snapshot.thread);
  const latestTurn = readRecord(thread?.latestTurn);
  const performance = readRecord(snapshot.performance);
  const activeThreadPerformance = readRecord(performance?.activeThread);
  const latestMessage = readRecord(activeThreadPerformance?.latestMessage);
  const latestActivity = readRecord(activeThreadPerformance?.latestActivity);
  const latestContextWindowActivity = readRecord(
    activeThreadPerformance?.latestContextWindowActivity,
  );

  // This intentionally avoids renderer receive/capture timestamps. A renderer can
  // publish fresh debug snapshots while the projected thread content is still old.
  return maxIsoTimestamp(
    latestMessage?.completedAt,
    latestMessage?.createdAt,
    latestActivity?.createdAt,
    latestContextWindowActivity?.createdAt,
    latestTurn?.completedAt,
    latestTurn?.startedAt,
    latestTurn?.requestedAt,
  );
}

function buildProviderRendererFreshnessDiagnostic(): Record<string, unknown> {
  const providerSnapshot = readRecord(state.providerDaemonSnapshot);
  const rendererSnapshot = readRecord(state.rendererSnapshot);
  const providerHealth = readRecord(providerSnapshot?.lastHealth);
  const runtimeEvents = readRecord(providerHealth?.runtimeEvents);
  const rendererRoute = readRecord(rendererSnapshot?.route);

  const activeThreadId = readString(rendererRoute?.activeThreadId);
  const providerLastThreadId = readString(runtimeEvents?.lastThreadId);
  const providerLastTurnId = readString(runtimeEvents?.lastTurnId);
  const providerLastEventAt = readIsoTimestamp(runtimeEvents?.lastEventAt);
  const rendererLatestVisibleAt =
    rendererSnapshot === null ? null : readRendererLatestVisibleTimestamp(rendererSnapshot);
  const providerEventCursor =
    readNumber(providerHealth?.newestEventCursor) ??
    readNumber(providerHealth?.eventCursor) ??
    readNumber(providerSnapshot?.eventCursor);

  const notes: string[] = [];
  if (providerSnapshot === null) {
    notes.push("Provider daemon snapshot is unavailable.");
  }
  if (rendererSnapshot === null) {
    notes.push("Renderer snapshot is unavailable.");
  }
  if (providerLastEventAt === null) {
    notes.push("Provider daemon has not reported a latest runtime event timestamp.");
  }
  if (rendererSnapshot !== null && rendererLatestVisibleAt === null) {
    notes.push("Renderer snapshot has no projected content timestamp for the active thread.");
  }
  if (
    activeThreadId !== null &&
    providerLastThreadId !== null &&
    providerLastThreadId !== activeThreadId
  ) {
    notes.push("Provider daemon latest event belongs to a different thread than the renderer.");
  }

  const comparable =
    providerLastEventAt !== null &&
    rendererLatestVisibleAt !== null &&
    (activeThreadId === null ||
      providerLastThreadId === null ||
      activeThreadId === providerLastThreadId);
  const lagMs = comparable
    ? Math.max(0, Date.parse(providerLastEventAt) - Date.parse(rendererLatestVisibleAt))
    : null;

  return {
    status: lagMs === null ? "unknown" : statusForProviderToRendererLag(lagMs),
    activeThreadId,
    providerLastThreadId,
    providerLastTurnId,
    providerEventCursor,
    providerLastEventAt,
    rendererLatestVisibleAt,
    rendererSnapshotUpdatedAt: state.rendererSnapshotUpdatedAt,
    lagMs,
    notes,
  };
}

function buildCompactDebugSnapshot(): Record<string, unknown> {
  const buildStartedAtMs = nodePerformance.now();
  const now = Date.now();
  const rendererSnapshotUpdatedAt = state.rendererSnapshotUpdatedAt;
  const rendererSnapshotAgeMs =
    rendererSnapshotUpdatedAt === null
      ? null
      : Math.max(0, now - Date.parse(rendererSnapshotUpdatedAt));
  const rendererSnapshotBytes =
    state.rendererSnapshot === null ? null : estimateJsonBytes(state.rendererSnapshot);
  const rendererSnapshotHistoryBytes = estimateJsonBytes(state.rendererSnapshotHistory);

  const snapshot: Record<string, unknown> = {
    schemaVersion: 1,
    debug: {
      detail: DEBUG_COMPACT_DETAIL_PARAM,
      enabled: state.enabled,
      bindHost: DEBUG_HOST,
      path: DEBUG_PATH,
      url: state.url,
      launchedAt: state.launchedAt,
      startedAt: state.startedAt,
      requestsServed: state.requestsServed,
      lastDebugRequestAt: state.lastDebugRequestAt,
      lastDebugRequestDurationMs: state.lastDebugRequestDurationMs,
      lastDebugResponseBytes: state.lastDebugResponseBytes,
      rendererSnapshotUpdatedAt,
      rendererSnapshotAgeMs,
      rendererSnapshotHistoryLimit: RENDERER_SNAPSHOT_HISTORY_LIMIT,
      providerDaemonSnapshotRefreshTtlMs: PROVIDER_DAEMON_DEBUG_REFRESH_TTL_MS,
      providerDaemonSnapshotRefresh: {
        timeoutMs: PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS,
        lastAttemptAt: state.providerDaemonSnapshotRefresh.lastAttemptAt,
        lastDurationMs: state.providerDaemonSnapshotRefresh.lastDurationMs,
        lastError: state.providerDaemonSnapshotRefresh.lastError,
        attemptCount: state.providerDaemonSnapshotRefresh.attemptCount,
        failureCount: state.providerDaemonSnapshotRefresh.failureCount,
        inFlight: state.providerDaemonSnapshotRefresh.inFlight,
      },
      fullDetailAvailable: true,
      fullDetailHint: `${DEBUG_PATH}?detail=${DEBUG_FULL_DETAIL_PARAM}`,
      omissions: {
        rawRendererSnapshot: state.rendererSnapshot !== null,
        rawProviderDaemonSnapshot: state.providerDaemonSnapshot !== null,
        rawPromptAndMessagePreviews: true,
        rawActivityPayloadPreviews: true,
        rawCommandAndEventArrays: true,
      },
    },
    performance: {
      debugSnapshotBuildDurationMs: null,
      rendererSnapshotBytes,
      rendererSnapshotHistoryBytes,
      rendererSnapshotAgeMs,
      eventLoop: readEventLoopSnapshot(),
      knownSlowValidationTargets: KNOWN_SLOW_VALIDATION_TARGETS,
    },
    process: summarizeProcessForCompactDebug(),
    providerDaemon: summarizeProviderDaemonForCompactDebug(),
    renderer: summarizeRendererForCompactDebug(),
    freshness: buildProviderRendererFreshnessDiagnostic(),
  };

  (
    snapshot.performance as {
      debugSnapshotBuildDurationMs: number;
    }
  ).debugSnapshotBuildDurationMs = roundDebugMs(nodePerformance.now() - buildStartedAtMs);

  return snapshot;
}

function buildFullDebugSnapshot(): Record<string, unknown> {
  const buildStartedAtMs = nodePerformance.now();
  const now = Date.now();
  const rendererSnapshotUpdatedAt = state.rendererSnapshotUpdatedAt;
  const rendererSnapshotAgeMs =
    rendererSnapshotUpdatedAt === null
      ? null
      : Math.max(0, now - Date.parse(rendererSnapshotUpdatedAt));
  const rendererSnapshotBytes =
    state.rendererSnapshot === null ? null : estimateJsonBytes(state.rendererSnapshot);
  const rendererSnapshotHistoryBytes = estimateJsonBytes(state.rendererSnapshotHistory);

  const snapshot: Record<string, unknown> = {
    schemaVersion: 1,
    debug: {
      detail: DEBUG_FULL_DETAIL_PARAM,
      enabled: state.enabled,
      bindHost: DEBUG_HOST,
      path: DEBUG_PATH,
      url: state.url,
      launchedAt: state.launchedAt,
      startedAt: state.startedAt,
      requestsServed: state.requestsServed,
      lastDebugRequestAt: state.lastDebugRequestAt,
      lastDebugRequestDurationMs: state.lastDebugRequestDurationMs,
      lastDebugResponseBytes: state.lastDebugResponseBytes,
      rendererSnapshotUpdatedAt,
      rendererSnapshotAgeMs,
      rendererSnapshotHistoryLimit: RENDERER_SNAPSHOT_HISTORY_LIMIT,
      providerDaemonSnapshotRefreshTtlMs: PROVIDER_DAEMON_DEBUG_REFRESH_TTL_MS,
      providerDaemonSnapshotRefresh: {
        timeoutMs: PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS,
        lastAttemptAt: state.providerDaemonSnapshotRefresh.lastAttemptAt,
        lastDurationMs: state.providerDaemonSnapshotRefresh.lastDurationMs,
        lastError: state.providerDaemonSnapshotRefresh.lastError,
        attemptCount: state.providerDaemonSnapshotRefresh.attemptCount,
        failureCount: state.providerDaemonSnapshotRefresh.failureCount,
        inFlight: state.providerDaemonSnapshotRefresh.inFlight,
      },
    },
    performance: {
      debugSnapshotBuildDurationMs: null,
      rendererSnapshotBytes,
      rendererSnapshotHistoryBytes,
      rendererSnapshotAgeMs,
      eventLoop: readEventLoopSnapshot(),
      knownSlowValidationTargets: KNOWN_SLOW_VALIDATION_TARGETS,
    },
    process: {
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: process.uptime(),
      cwd: process.cwd(),
      execPath: process.execPath,
      argv: process.argv.filter((arg) => DEBUG_SWITCHES.has(arg)),
      memoryUsage: process.memoryUsage(),
      resourceUsage: process.resourceUsage(),
      versions: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
      },
      diagnostics: {
        listenerInstalled: state.processDiagnostics.listenerInstalled,
        totalCount: state.processDiagnostics.totalCount,
        recentLimit: PROCESS_DIAGNOSTIC_HISTORY_LIMIT,
        recent: state.processDiagnostics.recent,
      },
    },
    providerDaemon:
      state.providerDaemonSnapshot === null
        ? {
            available: false,
            reason: "Provider daemon manager has not published a snapshot yet.",
          }
        : {
            available: true,
            snapshot: state.providerDaemonSnapshot,
          },
    renderer:
      state.rendererSnapshot === null
        ? {
            available: false,
            reason: "No renderer snapshot has been published yet.",
            history: state.rendererSnapshotHistory,
          }
        : {
            available: true,
            snapshot: state.rendererSnapshot,
            history: state.rendererSnapshotHistory,
          },
    freshness: buildProviderRendererFreshnessDiagnostic(),
  };

  (
    snapshot.performance as {
      debugSnapshotBuildDurationMs: number;
    }
  ).debugSnapshotBuildDurationMs = roundDebugMs(nodePerformance.now() - buildStartedAtMs);

  return snapshot;
}

function handleRequest(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse): void {
  const method = request.method ?? "GET";
  if (method !== "GET") {
    response.writeHead(405, {
      allow: "GET",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${DEBUG_HOST}`);
  if (url.pathname !== DEBUG_PATH) {
    writeJson(response, 404, {
      error: "not_found",
      debugPath: DEBUG_PATH,
    });
    return;
  }

  const requestStartedAtMs = nodePerformance.now();
  state.requestsServed += 1;
  void (async () => {
    const fullDetail = isFullDebugRequest(url);
    await prepareProviderDaemonSnapshotForDebugRequest(fullDetail);
    const responseBytes = writeJson(
      response,
      200,
      fullDetail ? buildFullDebugSnapshot() : buildCompactDebugSnapshot(),
      { pretty: fullDetail },
    );
    state.lastDebugRequestAt = new Date().toISOString();
    state.lastDebugRequestDurationMs = roundDebugMs(nodePerformance.now() - requestStartedAtMs);
    state.lastDebugResponseBytes = responseBytes;
  })().catch((error) => {
    recordDesktopProcessDiagnostic("manual", error, "debug_snapshot_failed");
    const responseBytes = writeJson(response, 500, {
      error: "debug_snapshot_failed",
      message: errorMessage(error),
    });
    state.lastDebugRequestAt = new Date().toISOString();
    state.lastDebugRequestDurationMs = roundDebugMs(nodePerformance.now() - requestStartedAtMs);
    state.lastDebugResponseBytes = responseBytes;
  });
}

export const getDebugEndpointState = Effect.sync(
  (): DesktopDebugEndpointState => ({
    enabled: state.enabled,
    url: state.url,
  }),
);

export const publishRendererDebugSnapshot = (
  snapshot: DesktopRendererDebugSnapshot,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!state.enabled) {
      return;
    }
    const receivedAt = new Date().toISOString();
    state.rendererSnapshot = snapshot;
    state.rendererSnapshotUpdatedAt = receivedAt;
    state.rendererSnapshotHistory = [
      ...state.rendererSnapshotHistory.slice(1 - RENDERER_SNAPSHOT_HISTORY_LIMIT),
      buildRendererSnapshotHistoryEntry(snapshot, receivedAt),
    ];
  });

export const publishProviderDaemonDebugSnapshot = (
  snapshot: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!state.enabled) {
      return;
    }
    state.providerDaemonSnapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    };
  });

export const setProviderDaemonDebugSnapshotRefresher = (
  refresher: (() => Promise<void>) | null,
): Effect.Effect<void> =>
  Effect.sync(() => {
    state.providerDaemonSnapshotRefresher = refresher;
  });

export const __desktopDebugServerTestApi = {
  reset(input: { readonly enabled?: boolean } = {}): void {
    stopEventLoopMonitor();
    if (state.server !== null) {
      state.server.close();
    }
    (state as { enabled: boolean }).enabled = input.enabled ?? true;
    state.startedAt = null;
    state.url = null;
    state.server = null;
    state.requestsServed = 0;
    state.lastDebugRequestAt = null;
    state.lastDebugRequestDurationMs = null;
    state.lastDebugResponseBytes = null;
    state.rendererSnapshot = null;
    state.providerDaemonSnapshot = null;
    state.providerDaemonSnapshotRefresher = null;
    state.providerDaemonSnapshotRefresh = {
      lastAttemptAt: null,
      lastDurationMs: null,
      lastError: null,
      attemptCount: 0,
      failureCount: 0,
      inFlight: false,
    };
    state.rendererSnapshotUpdatedAt = null;
    state.rendererSnapshotHistory = [];
    state.processDiagnostics = {
      listenerInstalled: false,
      totalCount: 0,
      recent: [],
    };
    state.eventLoop.startedAt = null;
    state.eventLoop.updatedAt = null;
    state.eventLoop.expectedAtMs = null;
    state.eventLoop.lastDelayMs = null;
    state.eventLoop.maxDelayMs = 0;
    state.eventLoop.totalDelayMs = 0;
    state.eventLoop.sampleCount = 0;
  },
  publishRendererSnapshot(snapshot: DesktopRendererDebugSnapshot): void {
    const receivedAt = new Date().toISOString();
    state.rendererSnapshot = snapshot;
    state.rendererSnapshotUpdatedAt = receivedAt;
    state.rendererSnapshotHistory = [
      ...state.rendererSnapshotHistory.slice(1 - RENDERER_SNAPSHOT_HISTORY_LIMIT),
      buildRendererSnapshotHistoryEntry(snapshot, receivedAt),
    ];
  },
  publishProviderDaemonSnapshot(snapshot: Record<string, unknown>): void {
    state.providerDaemonSnapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    };
  },
  setProviderDaemonSnapshotUpdatedAt(updatedAt: string): void {
    if (state.providerDaemonSnapshot !== null) {
      state.providerDaemonSnapshot = {
        ...state.providerDaemonSnapshot,
        updatedAt,
      };
    }
  },
  setProviderDaemonSnapshotRefresher(refresher: (() => Promise<void>) | null): void {
    state.providerDaemonSnapshotRefresher = refresher;
  },
  prepareProviderDaemonSnapshotForDebugRequest,
  buildCompactDebugSnapshot,
  buildFullDebugSnapshot,
  getProviderDaemonRefreshAttemptCount(): number {
    return state.providerDaemonSnapshotRefresh.attemptCount;
  },
  rendererHistoryLength(): number {
    return state.rendererSnapshotHistory.length;
  },
};

const startUnsafe: Effect.Effect<void, DesktopDebugServerStartError, Scope.Scope> = Effect.gen(
  function* () {
    if (!state.enabled || state.server !== null) {
      return;
    }

    installDesktopProcessDiagnosticListeners();

    const server = NodeHttp.createServer(handleRequest);
    const port = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            const address = server.address();
            if (!isAddressInfo(address)) {
              reject(new Error("Cafe Code debug server did not bind to a TCP address."));
              return;
            }
            resolve(address.port);
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(0, DEBUG_HOST);
        }),
      catch: (cause) => new DesktopDebugServerStartError({ cause }),
    });

    state.server = server;
    state.startedAt = new Date().toISOString();
    state.url = `http://${DEBUG_HOST}:${port}${DEBUG_PATH}`;
    startEventLoopMonitor();
    console.info(`[Cafe Code debug] ${state.url}`);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.close();
        stopEventLoopMonitor();
      }),
    );
  },
);

export const start: Effect.Effect<void, never, Scope.Scope> = startUnsafe.pipe(
  Effect.catch((error) =>
    Effect.logError("Cafe Code debug server failed to start", { cause: error.message }),
  ),
);
