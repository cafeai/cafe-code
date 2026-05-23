// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalConsoleInEffect:off
import type { DesktopDebugEndpointState, DesktopRendererDebugSnapshot } from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

const DEBUG_HOST = "127.0.0.1";
const DEBUG_PATH = "/debug";
const DEBUG_SWITCHES = new Set(["--cafe-debug", "--debug"]);
const RENDERER_SNAPSHOT_HISTORY_LIMIT = 50;

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
  rendererSnapshot: DesktopRendererDebugSnapshot | null;
  rendererSnapshotUpdatedAt: string | null;
  rendererSnapshotHistory: RendererSnapshotHistoryEntry[];
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
  rendererSnapshot: null,
  rendererSnapshotUpdatedAt: null,
  rendererSnapshotHistory: [],
};

function isAddressInfo(
  address: NodeNet.AddressInfo | string | null,
): address is NodeNet.AddressInfo {
  return typeof address === "object" && address !== null && typeof address.port === "number";
}

function writeJson(response: NodeHttp.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
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
    lifecycleRedFlags: readStringArray(activeLifecycle?.redFlags),
    queueLifecycleRedFlags: readStringArray(queueCoupling?.redFlags),
  };
}

function buildDebugSnapshot(): Record<string, unknown> {
  const now = Date.now();
  const rendererSnapshotUpdatedAt = state.rendererSnapshotUpdatedAt;
  const rendererSnapshotAgeMs =
    rendererSnapshotUpdatedAt === null
      ? null
      : Math.max(0, now - Date.parse(rendererSnapshotUpdatedAt));

  return {
    schemaVersion: 1,
    debug: {
      enabled: state.enabled,
      bindHost: DEBUG_HOST,
      path: DEBUG_PATH,
      url: state.url,
      launchedAt: state.launchedAt,
      startedAt: state.startedAt,
      requestsServed: state.requestsServed,
      rendererSnapshotUpdatedAt,
      rendererSnapshotAgeMs,
      rendererSnapshotHistoryLimit: RENDERER_SNAPSHOT_HISTORY_LIMIT,
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

  state.requestsServed += 1;
  writeJson(response, 200, buildDebugSnapshot());
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
    console.info(`[Cafe Code debug] ${state.url}`);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.close();
      }),
    );
  },
);

export const start: Effect.Effect<void, never, Scope.Scope> = startUnsafe.pipe(
  Effect.catch((error) =>
    Effect.logError("Cafe Code debug server failed to start", { cause: error.message }),
  ),
);
