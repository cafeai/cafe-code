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
const EVENT_LOOP_MONITOR_INTERVAL_MS = 1_000;

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
  rendererSnapshotUpdatedAt: string | null;
  rendererSnapshotHistory: RendererSnapshotHistoryEntry[];
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
  rendererSnapshotUpdatedAt: null,
  rendererSnapshotHistory: [],
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
    },
    performance: {
      debugSnapshotBuildDurationMs: null,
      rendererSnapshotBytes,
      rendererSnapshotHistoryBytes,
      rendererSnapshotAgeMs,
      eventLoop: readEventLoopSnapshot(),
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
  const responseBytes = writeJson(response, 200, buildDebugSnapshot());
  state.lastDebugRequestAt = new Date().toISOString();
  state.lastDebugRequestDurationMs = roundDebugMs(nodePerformance.now() - requestStartedAtMs);
  state.lastDebugResponseBytes = responseBytes;
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

const startUnsafe: Effect.Effect<void, DesktopDebugServerStartError, Scope.Scope> = Effect.gen(
  function* () {
    if (!state.enabled || state.server !== null) {
      return;
    }

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
