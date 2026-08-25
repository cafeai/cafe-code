// @effect-diagnostics nodeBuiltinImport:off
import {
  PROVIDER_DAEMON_EVENTS_PATH,
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_RPC_PATH,
  ProviderDaemonAdapterCapabilities,
  ProviderDaemonEventRecord,
  ProviderDaemonHealth,
  ProviderDaemonInstanceRoutingInfo,
  ProviderDaemonRpcEnvelope,
  ProviderDaemonRpcRequest,
  ProviderDaemonRpcResultByMethod,
  type ThreadId,
  type ProviderRuntimeEvent,
  type ProviderDaemonClientConfig,
} from "@cafecode/contracts";
import {
  requestProviderDaemonJson,
  streamProviderDaemonNdjson,
} from "@cafecode/shared/providerDaemonHttp";
import { PROVIDER_PIPELINE_POLICY } from "@cafecode/shared/providerPipelinePolicy";
import { addProviderBackendBridgeDiagnostics } from "@cafecode/shared/providerPipelineDiagnostics";
import * as crypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderValidationError,
  type ProviderServiceError,
} from "../provider/Errors.ts";
import type { ProviderAdapterCapabilities } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "../provider/Services/ProviderAdapterRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { ProjectionStateRepositoryLive } from "../persistence/Layers/ProjectionState.ts";
import {
  attachProviderDaemonRuntimeEventCursor,
  PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
  PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR,
  rewindProviderDaemonCursorForReplay,
} from "./ProviderDaemonRuntimeCursor.ts";

const decodeRpcEnvelopeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRpcEnvelope),
);
const decodeHealthJson = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderDaemonHealth));
const decodeEventRecordJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonEventRecord),
);
const decodeAdapterCapabilities = Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities);
const decodeInstanceRoutingInfo = Schema.decodeUnknownSync(ProviderDaemonInstanceRoutingInfo);
const encodeRpcRequestJson = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonRpcRequest));
const VOID_RPC_METHODS = new Set<ProviderDaemonRpcRequest["method"]>([
  "discardSessionFork",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "snoozeUserInput",
  "stopSession",
  "quiesceThreadForHardDelete",
  "rollbackConversation",
]);
const MUTATING_RPC_METHODS = new Set<ProviderDaemonRpcRequest["method"]>([
  "startSession",
  "forkSession",
  "discardSessionFork",
  "sendTurn",
  "steerTurn",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "snoozeUserInput",
  "stopSession",
  "quiesceThreadForHardDelete",
  "restartProviderRuntime",
  "setGoal",
  "clearGoal",
  "rollbackConversation",
]);
const PROVIDER_DAEMON_REPLAY_OVERLAP_EVENTS = 1_000;

function providerDaemonUrl(config: ProviderDaemonClientConfig, path: string): URL {
  return new URL(
    path,
    config.httpBaseUrl.endsWith("/") ? config.httpBaseUrl : `${config.httpBaseUrl}/`,
  );
}

/**
 * Internal transport error retaining the daemon's structured RPC error tag.
 *
 * The public service still exposes `ProviderAdapterRequestError`, but retaining
 * this tag prevents callers from confusing a refused daemon socket with a
 * genuine `ProviderUnsupportedError` returned by the remote registry.
 */
export class ProviderDaemonRpcResponseError extends Error {
  readonly remoteErrorTag: string;

  constructor(remoteErrorTag: string, message: string) {
    super(message);
    this.name = "ProviderDaemonRpcResponseError";
    this.remoteErrorTag = remoteErrorTag;
  }
}

export function toRemoteRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: "provider-daemon",
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof ProviderDaemonRpcResponseError
      ? { remoteErrorTag: cause.remoteErrorTag }
      : {}),
    cause,
  });
}

function toProviderRuntimeEndpointUnavailable(): ProviderValidationError {
  return new ProviderValidationError({
    operation: "ProviderDaemonRemoteProviderService",
    issue: "Provider daemon or supervisor endpoint is not configured for this server process.",
  });
}

export const attachCommandIdToMutatingProviderDaemonRequest = <
  M extends ProviderDaemonRpcRequest["method"],
>(
  request: Extract<ProviderDaemonRpcRequest, { readonly method: M }>,
): Extract<ProviderDaemonRpcRequest, { readonly method: M }> => {
  const commandId = "commandId" in request ? request.commandId : undefined;
  return (
    MUTATING_RPC_METHODS.has(request.method)
      ? { ...request, commandId: commandId ?? crypto.randomUUID() }
      : request
  ) as Extract<ProviderDaemonRpcRequest, { readonly method: M }>;
};

export const isVoidProviderDaemonRpcMethod = (
  method: ProviderDaemonRpcRequest["method"],
): boolean => VOID_RPC_METHODS.has(method);

/**
 * Identify every immutable Cafe thread that one daemon RPC can mutate or
 * inspect. Keeping this exhaustive and next to the transport means a future
 * thread-scoped RPC cannot silently bypass the backend's permanent-delete
 * fence. Forks deliberately include both identities: the native allocation
 * reads the source while its durable binding is written under the target.
 */
export const providerDaemonRequestThreadIds = (
  request: ProviderDaemonRpcRequest,
): ReadonlyArray<ThreadId> => {
  switch (request.method) {
    case "startSession":
    case "sendTurn":
    case "steerTurn":
    case "interruptTurn":
    case "respondToRequest":
    case "respondToUserInput":
    case "snoozeUserInput":
    case "stopSession":
    case "quiesceThreadForHardDelete":
    case "getGoal":
    case "setGoal":
    case "clearGoal":
    case "rollbackConversation":
    case "readSubagentDetail":
      return [request.payload.threadId];
    case "forkSession":
      return [request.payload.sourceThreadId, request.payload.targetThreadId];
    case "discardSessionFork":
      return [request.payload.fork.targetThreadId];
    case "restartProviderRuntime":
    case "listSessions":
    case "getCapabilities":
    case "getInstanceInfo":
      return [];
    default: {
      const unreachable: never = request;
      return unreachable;
    }
  }
};

/** Reject locally retired identities before evaluating the HTTP request. */
export const guardRemoteProviderThreadOperation = <A, E, R>(input: {
  readonly retiredThreadIds: ReadonlySet<string>;
  readonly operation: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly effect: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | ProviderValidationError, R> =>
  Effect.suspend((): Effect.Effect<A, E | ProviderValidationError, R> => {
    const retiredThreadId = input.threadIds.find((threadId) =>
      input.retiredThreadIds.has(String(threadId)),
    );
    return retiredThreadId === undefined
      ? input.effect
      : Effect.fail(
          new ProviderValidationError({
            operation: input.operation,
            issue: `Thread '${retiredThreadId}' is permanently retired and cannot accept provider work.`,
          }),
        );
  });

const rpc = <M extends ProviderDaemonRpcRequest["method"]>(
  daemonConfig: ProviderDaemonClientConfig,
  request: Extract<ProviderDaemonRpcRequest, { readonly method: M }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const requestWithCommandId = attachCommandIdToMutatingProviderDaemonRequest(request);
      const response = await requestProviderDaemonJson(daemonConfig, PROVIDER_DAEMON_RPC_PATH, {
        method: "POST",
        body: encodeRpcRequestJson(requestWithCommandId),
      });
      const envelope = decodeRpcEnvelopeJson(response.body);
      if (!envelope.ok) {
        const rootCause = envelope.error.diagnostics?.causeChain.find(
          (entry) => entry.message !== envelope.error.message && entry.message.length > 0,
        );
        throw new ProviderDaemonRpcResponseError(
          envelope.error.tag,
          rootCause === undefined
            ? `${envelope.error.tag}: ${envelope.error.message}`
            : `${envelope.error.tag}: ${envelope.error.message}; caused by ${rootCause.message}`,
        );
      }
      if (isVoidProviderDaemonRpcMethod(request.method)) {
        return undefined as Schema.Schema.Type<(typeof ProviderDaemonRpcResultByMethod)[M]>;
      }
      const resultSchema = ProviderDaemonRpcResultByMethod[request.method];
      return Schema.decodeUnknownSync(resultSchema)(envelope.value) as Schema.Schema.Type<
        (typeof ProviderDaemonRpcResultByMethod)[M]
      >;
    },
    catch: (cause) => toRemoteRequestError(request.method, cause),
  });

async function readEventStream(
  daemonConfig: ProviderDaemonClientConfig,
  afterCursor: number,
  onRecord: (record: typeof ProviderDaemonEventRecord.Type) => Promise<void>,
): Promise<void> {
  const url = providerDaemonUrl(daemonConfig, PROVIDER_DAEMON_EVENTS_PATH);
  url.searchParams.set("after", String(Math.max(0, Math.trunc(afterCursor))));
  await streamProviderDaemonNdjson(daemonConfig, `${url.pathname}${url.search}`, {
    onLine: async (line) => onRecord(decodeEventRecordJson(line)),
  });
}

async function readRemoteHealth(
  daemonConfig: ProviderDaemonClientConfig,
): Promise<typeof ProviderDaemonHealth.Type> {
  const response = await requestProviderDaemonJson(daemonConfig, PROVIDER_DAEMON_HEALTH_PATH, {
    method: "GET",
  });
  return decodeHealthJson(response.body);
}

function isProviderDaemonQuarantineGap(event: ProviderRuntimeEvent): boolean {
  if (event.type !== "runtime.warning") return false;
  const detail = event.payload.detail;
  return (
    detail !== null &&
    typeof detail === "object" &&
    "category" in detail &&
    detail.category === "provider-daemon-quarantine-gap"
  );
}

export function remoteProviderCursorProjectorForConfig(config: {
  readonly providerDaemon?: unknown;
  readonly providerSupervisor?: unknown;
}): string {
  return config.providerDaemon !== undefined
    ? PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR
    : PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR;
}

const makeRemoteProviderService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const daemonConfig = config.providerDaemon ?? config.providerSupervisor;
  if (daemonConfig === undefined) {
    return yield* toProviderRuntimeEndpointUnavailable();
  }
  const remoteCursorProjector = remoteProviderCursorProjectorForConfig(config);

  // Canonical events are bounded to 256 KiB before this bridge. Capping by the
  // stricter of count and byte-derived capacity gives the daemon HTTP reader a
  // real backpressure point without relying on average event size.
  const bridgeQueueCapacity = Math.max(
    1,
    Math.min(
      PROVIDER_PIPELINE_POLICY.bridgeQueueMaxRecords,
      Math.floor(
        PROVIDER_PIPELINE_POLICY.bridgeQueueMaxBytes /
          PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
      ),
    ),
  );
  const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(bridgeQueueCapacity);
  // The daemon owns provider processes, but this bridge owns delivery into the
  // backend ingestion worker. Fence locally before sending the daemon RPC so
  // a journal record already in flight cannot arrive after the backend has
  // drained ingestion and committed permanent deletion.
  const hardDeleteRetiredThreadIds = new Set<string>();
  const guardedRpc = <M extends ProviderDaemonRpcRequest["method"]>(
    request: Extract<ProviderDaemonRpcRequest, { readonly method: M }>,
  ) =>
    guardRemoteProviderThreadOperation({
      retiredThreadIds: hardDeleteRetiredThreadIds,
      operation: `ProviderDaemonRemoteProviderService.${request.method}`,
      threadIds: providerDaemonRequestThreadIds(request),
      effect: rpc(daemonConfig, request),
    });
  const publishContext = yield* Effect.context<never>();
  const publishRuntimeEvent = Effect.runPromiseWith(publishContext);
  const initialProjectionState = yield* projectionStateRepository
    .getByProjector({ projector: remoteCursorProjector })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider daemon event cursor read failed", {
          projector: remoteCursorProjector,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none())),
      ),
    );
  let eventCursor = Option.match(initialProjectionState, {
    onNone: () => 0,
    onSome: (state) =>
      rewindProviderDaemonCursorForReplay(
        state.lastAppliedSequence,
        PROVIDER_DAEMON_REPLAY_OVERLAP_EVENTS,
      ),
  });

  if (
    Option.isNone(initialProjectionState) &&
    remoteCursorProjector === PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR
  ) {
    eventCursor = yield* Effect.tryPromise({
      try: async () => {
        const health = await readRemoteHealth(daemonConfig);
        // A newly-upgraded daemon has no dedicated daemon->supervisor cursor yet.
        // If the supervisor is idle, start near its live tail rather than replaying
        // every retained historical event into the daemon again. If sessions are
        // active, prefer correctness and replay from zero because events may have
        // arrived while the daemon was down.
        if (health.activeSessionCount > 0) {
          return 0;
        }
        return rewindProviderDaemonCursorForReplay(
          health.eventCursor,
          PROVIDER_DAEMON_REPLAY_OVERLAP_EVENTS,
        );
      },
      catch: (cause) => toRemoteRequestError("health", cause),
    }).pipe(
      Effect.tap((cursor) =>
        cursor > 0
          ? Effect.logInfo("provider supervisor event stream bootstrapping near idle tail", {
              projector: remoteCursorProjector,
              afterCursor: cursor,
              replayOverlapEvents: PROVIDER_DAEMON_REPLAY_OVERLAP_EVENTS,
            })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider supervisor event cursor bootstrap failed", {
          projector: remoteCursorProjector,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(0)),
      ),
    );
  }

  if (eventCursor > 0) {
    yield* Effect.logInfo("provider daemon event stream resuming from persisted cursor", {
      projector: remoteCursorProjector,
      afterCursor: eventCursor,
      replayOverlapEvents: PROVIDER_DAEMON_REPLAY_OVERLAP_EVENTS,
    });
  }

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.tryPromise({
        try: () =>
          readEventStream(daemonConfig, eventCursor, async (record) => {
            if (isProviderDaemonQuarantineGap(record.event)) {
              // The daemon made a durable payload-free forward-progress
              // decision. Re-read live session inventory before advancing the
              // bridge cursor so the backend does not infer session truth from
              // the missing incompatible event.
              await publishRuntimeEvent(
                rpc(daemonConfig, { method: "listSessions", payload: {} }).pipe(
                  Effect.tap((sessions) =>
                    Effect.logWarning("provider daemon event quarantine gap reconciled", {
                      cursor: record.cursor,
                      activeSessionCount: sessions.length,
                    }),
                  ),
                  Effect.catch(() => Effect.void),
                ),
              );
              eventCursor = Math.max(eventCursor, record.cursor);
              return;
            }
            if (hardDeleteRetiredThreadIds.has(String(record.event.threadId))) {
              eventCursor = Math.max(eventCursor, record.cursor);
              return;
            }
            await publishRuntimeEvent(
              PubSub.publish(
                runtimeEventPubSub,
                attachProviderDaemonRuntimeEventCursor(record.event, record.cursor),
              ),
            );
            addProviderBackendBridgeDiagnostics({ acceptedRecordCount: 1 });
            // A cursor is durable progress only after downstream acceptance.
            // Advancing first can permanently skip a record after a crash.
            eventCursor = Math.max(eventCursor, record.cursor);
          }),
        catch: (cause) => toRemoteRequestError("streamEvents", cause),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider daemon event stream disconnected", {
            cursor: eventCursor,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* Effect.sleep(Duration.millis(500));
    }
  }).pipe(Effect.forkScoped);

  const service: ProviderServiceShape = {
    startSession: (threadId, input) =>
      guardedRpc({
        method: "startSession",
        payload: { ...input, threadId },
      }),
    forkSession: (input) => guardedRpc({ method: "forkSession", payload: input }),
    discardSessionFork: (input) => guardedRpc({ method: "discardSessionFork", payload: input }),
    sendTurn: (input) => guardedRpc({ method: "sendTurn", payload: input }),
    steerTurn: (input) => guardedRpc({ method: "steerTurn", payload: input }),
    interruptTurn: (input) => guardedRpc({ method: "interruptTurn", payload: input }),
    respondToRequest: (input) => guardedRpc({ method: "respondToRequest", payload: input }),
    respondToUserInput: (input) => guardedRpc({ method: "respondToUserInput", payload: input }),
    snoozeUserInput: (input) => guardedRpc({ method: "snoozeUserInput", payload: input }),
    stopSession: (input) => guardedRpc({ method: "stopSession", payload: input }),
    quiesceThreadForHardDelete: (input) =>
      Effect.sync(() => {
        hardDeleteRetiredThreadIds.add(String(input.threadId));
      }).pipe(
        Effect.andThen(rpc(daemonConfig, { method: "quiesceThreadForHardDelete", payload: input })),
      ),
    restartProviderRuntime: (input) =>
      guardedRpc({ method: "restartProviderRuntime", payload: input }),
    listSessions: () =>
      guardedRpc({ method: "listSessions", payload: {} }).pipe(
        Effect.map((sessions) =>
          sessions.filter((session) => !hardDeleteRetiredThreadIds.has(String(session.threadId))),
        ),
        Effect.catch((error) =>
          Effect.logWarning("provider daemon listSessions failed", {
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      ),
    getCapabilities: (instanceId) =>
      guardedRpc({ method: "getCapabilities", payload: { instanceId } }).pipe(
        Effect.map(
          (capabilities) => decodeAdapterCapabilities(capabilities) as ProviderAdapterCapabilities,
        ),
      ),
    getInstanceInfo: (instanceId) =>
      guardedRpc({ method: "getInstanceInfo", payload: { instanceId } }).pipe(
        Effect.map((info) => decodeInstanceRoutingInfo(info) as ProviderInstanceRoutingInfo),
      ),
    getGoal: (input) => guardedRpc({ method: "getGoal", payload: input }),
    setGoal: (input) => guardedRpc({ method: "setGoal", payload: input }),
    clearGoal: (input) => guardedRpc({ method: "clearGoal", payload: input }),
    rollbackConversation: (input) => guardedRpc({ method: "rollbackConversation", payload: input }),
    readSubagentDetail: (input) => guardedRpc({ method: "readSubagentDetail", payload: input }),
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return service;
});

export const RemoteProviderServiceLive = Layer.effect(
  ProviderService,
  makeRemoteProviderService,
).pipe(Layer.provide(ProjectionStateRepositoryLive));

export type RemoteProviderServiceError = ProviderServiceError;
