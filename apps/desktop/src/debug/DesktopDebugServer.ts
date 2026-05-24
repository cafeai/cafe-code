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
import { performance as nodePerformance } from "node:perf_hooks";

const DEBUG_HOST = "127.0.0.1";
const DEBUG_PATH = "/debug";
const DEBUG_SWITCHES = new Set(["--cafe-debug", "--debug"]);
const RENDERER_SNAPSHOT_HISTORY_LIMIT = 50;
const PROCESS_DIAGNOSTIC_HISTORY_LIMIT = 50;
const EVENT_LOOP_MONITOR_INTERVAL_MS = 1_000;
const PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS = 2_000;
const PROCESS_DIAGNOSTIC_MESSAGE_LIMIT = 4_000;
const PROCESS_DIAGNOSTIC_STACK_LIMIT = 16_000;
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

function writeJson(response: NodeHttp.ServerResponse, statusCode: number, body: unknown): number {
  const responseBody = `${JSON.stringify(body, null, 2)}\n`;
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
  if (refresher === null) {
    return;
  }

  const refreshStartedAtMs = nodePerformance.now();
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
  }
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
  };
}

function buildDebugSnapshot(): Record<string, unknown> {
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
      providerDaemonSnapshotRefresh: {
        timeoutMs: PROVIDER_DAEMON_DEBUG_REFRESH_TIMEOUT_MS,
        lastAttemptAt: state.providerDaemonSnapshotRefresh.lastAttemptAt,
        lastDurationMs: state.providerDaemonSnapshotRefresh.lastDurationMs,
        lastError: state.providerDaemonSnapshotRefresh.lastError,
        attemptCount: state.providerDaemonSnapshotRefresh.attemptCount,
        failureCount: state.providerDaemonSnapshotRefresh.failureCount,
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
    await refreshProviderDaemonSnapshotForDebugRequest();
    const responseBytes = writeJson(response, 200, buildDebugSnapshot());
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
