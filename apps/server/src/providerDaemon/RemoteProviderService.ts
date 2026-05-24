// @effect-diagnostics nodeBuiltinImport:off
import {
  PROVIDER_DAEMON_EVENTS_PATH,
  PROVIDER_DAEMON_RPC_PATH,
  ProviderDaemonAdapterCapabilities,
  ProviderDaemonEventRecord,
  ProviderDaemonInstanceRoutingInfo,
  ProviderDaemonRpcEnvelope,
  ProviderDaemonRpcRequest,
  ProviderDaemonRpcResultByMethod,
  type ProviderRuntimeEvent,
  type ProviderDaemonClientConfig,
} from "@cafecode/contracts";
import {
  requestProviderDaemonJson,
  streamProviderDaemonNdjson,
} from "@cafecode/shared/providerDaemonHttp";
import * as crypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const decodeRpcEnvelopeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRpcEnvelope),
);
const decodeEventRecordJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonEventRecord),
);
const decodeAdapterCapabilities = Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities);
const decodeInstanceRoutingInfo = Schema.decodeUnknownSync(ProviderDaemonInstanceRoutingInfo);
const encodeRpcRequestJson = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonRpcRequest));
const VOID_RPC_METHODS = new Set<ProviderDaemonRpcRequest["method"]>([
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "stopSession",
  "rollbackConversation",
]);
const MUTATING_RPC_METHODS = new Set<ProviderDaemonRpcRequest["method"]>([
  "startSession",
  "sendTurn",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "stopSession",
  "rollbackConversation",
]);

function providerDaemonUrl(config: ProviderDaemonClientConfig, path: string): URL {
  return new URL(
    path,
    config.httpBaseUrl.endsWith("/") ? config.httpBaseUrl : `${config.httpBaseUrl}/`,
  );
}

function toRemoteRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: "provider-daemon",
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function toProviderRuntimeEndpointUnavailable(): ProviderValidationError {
  return new ProviderValidationError({
    operation: "ProviderDaemonRemoteProviderService",
    issue: "Provider daemon or supervisor endpoint is not configured for this server process.",
  });
}

const rpc = <M extends ProviderDaemonRpcRequest["method"]>(
  daemonConfig: ProviderDaemonClientConfig,
  request: Extract<ProviderDaemonRpcRequest, { readonly method: M }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const commandId = "commandId" in request ? request.commandId : undefined;
      const requestWithCommandId = (
        MUTATING_RPC_METHODS.has(request.method)
          ? { ...request, commandId: commandId ?? crypto.randomUUID() }
          : request
      ) as Extract<ProviderDaemonRpcRequest, { readonly method: M }>;
      const response = await requestProviderDaemonJson(daemonConfig, PROVIDER_DAEMON_RPC_PATH, {
        method: "POST",
        body: encodeRpcRequestJson(requestWithCommandId),
      });
      const envelope = decodeRpcEnvelopeJson(response.body);
      if (!envelope.ok) {
        const rootCause = envelope.error.diagnostics?.causeChain.find(
          (entry) => entry.message !== envelope.error.message && entry.message.length > 0,
        );
        throw new Error(
          rootCause === undefined
            ? `${envelope.error.tag}: ${envelope.error.message}`
            : `${envelope.error.tag}: ${envelope.error.message}; caused by ${rootCause.message}`,
        );
      }
      if (VOID_RPC_METHODS.has(request.method)) {
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
  onRecord: (record: typeof ProviderDaemonEventRecord.Type) => void,
): Promise<void> {
  const url = providerDaemonUrl(daemonConfig, PROVIDER_DAEMON_EVENTS_PATH);
  url.searchParams.set("after", String(Math.max(0, Math.trunc(afterCursor))));
  await streamProviderDaemonNdjson(daemonConfig, `${url.pathname}${url.search}`, {
    onLine: (line) => onRecord(decodeEventRecordJson(line)),
  });
}

const makeRemoteProviderService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const daemonConfig = config.providerDaemon ?? config.providerSupervisor;
  if (daemonConfig === undefined) {
    return yield* toProviderRuntimeEndpointUnavailable();
  }

  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const publishContext = yield* Effect.context<never>();
  const publishRuntimeEvent = Effect.runSyncWith(publishContext);
  let eventCursor = 0;

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.tryPromise({
        try: () =>
          readEventStream(daemonConfig, eventCursor, (record) => {
            eventCursor = Math.max(eventCursor, record.cursor);
            publishRuntimeEvent(PubSub.publish(runtimeEventPubSub, record.event));
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
      rpc(daemonConfig, {
        method: "startSession",
        payload: { ...input, threadId },
      }),
    sendTurn: (input) => rpc(daemonConfig, { method: "sendTurn", payload: input }),
    interruptTurn: (input) => rpc(daemonConfig, { method: "interruptTurn", payload: input }),
    respondToRequest: (input) => rpc(daemonConfig, { method: "respondToRequest", payload: input }),
    respondToUserInput: (input) =>
      rpc(daemonConfig, { method: "respondToUserInput", payload: input }),
    stopSession: (input) => rpc(daemonConfig, { method: "stopSession", payload: input }),
    listSessions: () =>
      rpc(daemonConfig, { method: "listSessions", payload: {} }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("provider daemon listSessions failed", {
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      ),
    getCapabilities: (instanceId) =>
      rpc(daemonConfig, { method: "getCapabilities", payload: { instanceId } }).pipe(
        Effect.map(
          (capabilities) => decodeAdapterCapabilities(capabilities) as ProviderAdapterCapabilities,
        ),
      ),
    getInstanceInfo: (instanceId) =>
      rpc(daemonConfig, { method: "getInstanceInfo", payload: { instanceId } }).pipe(
        Effect.map((info) => decodeInstanceRoutingInfo(info) as ProviderInstanceRoutingInfo),
      ),
    rollbackConversation: (input) =>
      rpc(daemonConfig, { method: "rollbackConversation", payload: input }),
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return service;
});

export const RemoteProviderServiceLive = Layer.effect(ProviderService, makeRemoteProviderService);

export type RemoteProviderServiceError = ProviderServiceError;
