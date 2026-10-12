import { WsRpcGroup } from "@cafecode/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  recordWsConnectionTerminalError,
  recordWsHeartbeatTimeout,
  recordWsRetryScheduled,
  type WsConnectionMetadata,
} from "./wsConnectionState";

export interface WsProtocolCloseContext {
  readonly intentional: boolean;
}

export interface WsProtocolRetryScheduled {
  readonly retryIndex: number;
  readonly delayMs: number;
  readonly nextRetryAt: string;
}

export interface WsProtocolLifecycleHandlers {
  /**
   * The singleton renderer connection atom represents the primary Cafe
   * backend. Auxiliary saved-environment transports have their own scoped
   * runtime state and must opt out so one remote socket cannot make a healthy
   * primary chat display "Reconnecting" (or hide a real primary outage).
   */
  readonly trackGlobalConnectionStatus?: boolean;
  readonly getConnectionLabel?: () => string | null;
  readonly getVersionMismatchHint?: () => string | null;
  readonly isCloseIntentional?: () => boolean;
  readonly isActive?: () => boolean;
  readonly onSessionStart?: () => void;
  /** A token-acquisition attempt has no usable socket URL until it succeeds. */
  readonly onAttempt?: (socketUrl: string | null) => void;
  readonly onOpen?: () => void;
  readonly onHeartbeatPing?: () => void;
  readonly onHeartbeatPong?: () => void;
  readonly onHeartbeatTimeout?: () => void;
  readonly onRequestStart?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestChunk?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly chunkCount: number;
  }) => void;
  readonly onRequestExit?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestInterrupt?: (info: { readonly id: string; readonly tag?: string }) => void;
  readonly onError?: (message: string) => void;
  /**
   * Remote authentication/configuration owners classify URL acquisition errors
   * without exposing their possibly credential-bearing text to diagnostics.
   * Returning false stops this session until an explicit reconnect is requested.
   */
  readonly shouldRetryUrlError?: (error: unknown) => boolean;
  readonly onTerminalError?: (message: string) => void;
  readonly onRetryScheduled?: (info: WsProtocolRetryScheduled) => void;
  readonly onClose?: (
    details: { readonly code: number; readonly reason: string },
    context: WsProtocolCloseContext,
  ) => void;
}

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
export type WsRpcProtocolSocketUrlProvider = string | (() => Promise<string>);

const WS_CONNECTION_FAILURE_MESSAGE = "Unable to connect to the Cafe Code server WebSocket.";

function makeSocketAcquisitionError(): Socket.SocketError {
  // URL providers acquire authenticated, single-use WebSocket tokens. Their
  // rejection text can contain a bearer credential or private URL, so neither
  // lifecycle observers nor RPC defects may retain that external error object.
  return new Socket.SocketError({
    reason: new Socket.SocketOpenError({
      kind: "Unknown",
      cause: new Error(WS_CONNECTION_FAILURE_MESSAGE),
    }),
  });
}

function resolveWsRpcSocketUrl(rawUrl: string): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  resolved.pathname = "/ws";
  return resolved.toString();
}

function resolveConnectionMetadata(handlers?: WsProtocolLifecycleHandlers): WsConnectionMetadata {
  return {
    connectionLabel: handlers?.getConnectionLabel?.() ?? null,
    versionMismatchHint: handlers?.getVersionMismatchHint?.() ?? null,
  };
}

function shouldTrackGlobalConnectionStatus(handlers?: WsProtocolLifecycleHandlers): boolean {
  return handlers?.trackGlobalConnectionStatus !== false;
}

type ComposedWsProtocolLifecycleHandlers = Required<
  Pick<
    WsProtocolLifecycleHandlers,
    | "isActive"
    | "onAttempt"
    | "onOpen"
    | "onError"
    | "onTerminalError"
    | "onRetryScheduled"
    | "onClose"
  >
>;

function defaultLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  return {
    isActive: () => true,
    onAttempt: (socketUrl) => {
      if (shouldTrackGlobalConnectionStatus(handlers)) {
        recordWsConnectionAttempt(socketUrl, resolveConnectionMetadata(handlers));
      }
    },
    onOpen: () => {
      if (shouldTrackGlobalConnectionStatus(handlers)) {
        recordWsConnectionOpened(resolveConnectionMetadata(handlers));
      }
    },
    onError: (message) => {
      clearAllTrackedRpcRequests();
      if (shouldTrackGlobalConnectionStatus(handlers)) {
        recordWsConnectionErrored(message, resolveConnectionMetadata(handlers));
      }
    },
    onTerminalError: (message) => {
      clearAllTrackedRpcRequests();
      if (shouldTrackGlobalConnectionStatus(handlers)) {
        recordWsConnectionTerminalError(message, resolveConnectionMetadata(handlers));
      }
    },
    onRetryScheduled: (info) => {
      if (shouldTrackGlobalConnectionStatus(handlers)) {
        recordWsRetryScheduled(info, resolveConnectionMetadata(handlers));
      }
    },
    onClose: (details, context) => {
      clearAllTrackedRpcRequests();
      if (context.intentional) {
        return;
      }
      if (shouldTrackGlobalConnectionStatus(handlers)) {
        recordWsConnectionClosed(details, resolveConnectionMetadata(handlers));
      }
    },
  };
}

function composeLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  const defaults = defaultLifecycleHandlers(handlers);
  const isActive = handlers?.isActive ?? defaults.isActive;

  return {
    isActive,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      defaults.onAttempt(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      defaults.onOpen();
      handlers?.onOpen?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      defaults.onError(message);
      handlers?.onError?.(message);
    },
    onTerminalError: (message) => {
      if (!isActive()) {
        return;
      }
      defaults.onTerminalError(message);
      handlers?.onTerminalError?.(message);
    },
    onRetryScheduled: (info) => {
      if (!isActive()) {
        return;
      }
      defaults.onRetryScheduled(info);
      handlers?.onRetryScheduled?.(info);
    },
    onClose: (details, context) => {
      if (!isActive()) {
        return;
      }
      defaults.onClose(details, context);
      handlers?.onClose?.(details, context);
    },
  };
}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
) {
  const lifecycle = composeLifecycleHandlers(handlers);
  const staticSocketUrl = typeof url === "string" ? resolveWsRpcSocketUrl(url) : null;
  let terminalUrlFailure = false;
  let failedAttemptLatch = Latch.makeUnsafe(false);
  let hasStartedSocketAttempt = false;
  const requestFailure = Effect.fail(
    new RpcClientError.RpcClientError({ reason: makeSocketAcquisitionError().reason }),
  );
  const resolvedUrl =
    typeof url === "function"
      ? Effect.tryPromise({
          try: () => url(),
          catch: (error) => {
            // A transient network/server failure may retry token issuance; an
            // explicit auth or configuration rejection cannot acquire authority
            // by retrying. If the owner classifier itself fails, stop instead of
            // turning uncertainty into an authentication recovery loop.
            try {
              terminalUrlFailure = handlers?.shouldRetryUrlError?.(error) === false;
            } catch {
              terminalUrlFailure = true;
            }
            return makeSocketAcquisitionError();
          },
        }).pipe(
          Effect.flatMap((rawUrl) =>
            Effect.try({
              try: () => resolveWsRpcSocketUrl(rawUrl),
              catch: () => {
                terminalUrlFailure = true;
                return makeSocketAcquisitionError();
              },
            }),
          ),
        )
      : Effect.succeed(staticSocketUrl!);
  let activeSocket: globalThis.WebSocket | undefined;
  let nextRetryIndex = 0;

  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      const socket = new globalThis.WebSocket(socketUrl, protocols);
      activeSocket = socket;
      const isCurrentSocket = () => lifecycle.isActive() && activeSocket === socket;

      socket.addEventListener(
        "open",
        () => {
          if (!isCurrentSocket()) {
            return;
          }
          lifecycle.onOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          if (isCurrentSocket()) {
            lifecycle.onError(WS_CONNECTION_FAILURE_MESSAGE);
          }
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          if (!isCurrentSocket()) {
            return;
          }
          lifecycle.onClose(
            {
              code: event.code,
              reason: event.reason,
            },
            {
              intentional: handlers?.isCloseIntentional?.() ?? false,
            },
          );
        },
        { once: true },
      );

      return socket;
    },
  );
  const socketLayer = Layer.effect(
    Socket.Socket,
    Socket.WebSocketConstructor.use((makeWebSocket) =>
      Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.sync(() => {
            // Acquiring a fresh token is part of a connection attempt, even
            // when no browser WebSocket can be constructed. Count it exactly
            // once before acquisition; the constructor must not count it again.
            // Retire prior socket callbacks before a delayed URL request can
            // publish observations from an obsolete socket in this session.
            activeSocket = undefined;
            if (hasStartedSocketAttempt) {
              // Requests retain the prior attempt's opened latch. Reusing and
              // closing it could accidentally let an old blocked write wait
              // for this replacement socket and deliver a stale mutation.
              failedAttemptLatch = Latch.makeUnsafe(false);
            }
            hasStartedSocketAttempt = true;
            terminalUrlFailure = false;
            lifecycle.onAttempt(staticSocketUrl);
          }).pipe(
            Effect.andThen(resolvedUrl),
            Effect.flatMap((socketUrl) =>
              Effect.try({
                try: () => makeWebSocket(socketUrl),
                catch: () => {
                  // A browser constructor rejection is a local configuration
                  // or policy failure, not an unavailable server. It cannot be
                  // repaired by repeatedly acquiring fresh credentials.
                  terminalUrlFailure = true;
                  return makeSocketAcquisitionError();
                },
              }),
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                failedAttemptLatch.openUnsafe();
                if (terminalUrlFailure) {
                  lifecycle.onTerminalError(WS_CONNECTION_FAILURE_MESSAGE);
                } else {
                  lifecycle.onError(WS_CONNECTION_FAILURE_MESSAGE);
                }
              }),
            ),
          ),
          (socket) => Effect.sync(() => socket.close(1000)),
        ),
      ),
    ),
  ).pipe(Layer.provide(trackingWebSocketConstructorLayer));
  const retryPolicy = Schedule.forever.pipe(
    // Backend overload/restart is inconclusive, not a permanent outage. Keep
    // one bounded retry loop alive at the capped delay so recovery can happen
    // when the server returns, without remounting or replaying application work.
    Schedule.while(() => Effect.sync(() => !terminalUrlFailure)),
    Schedule.addDelay(() =>
      Effect.sync(() => {
        const delayMs = getWsReconnectDelayMsForRetry(nextRetryIndex);
        const retryIndex = nextRetryIndex;
        nextRetryIndex = Math.min(Number.MAX_SAFE_INTEGER, nextRetryIndex + 1);
        lifecycle.onRetryScheduled({
          retryIndex,
          delayMs: delayMs ?? 0,
          nextRetryAt: new Date(Date.now() + (delayMs ?? 0)).toISOString(),
        });
        return Duration.millis(delayMs ?? 0);
      }),
    ),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        // Every failed socket generation must reject pending acknowledgements
        // and subscriptions, including heartbeat/URL errors. Generic requests
        // are never replayed by this protocol; only the separate durable-command
        // wrapper may retry the exact idempotent command after an unknown ACK.
        retryTransientErrors: false,
      }),
      (protocol) => ({
        ...protocol,
        send: (...args: Parameters<typeof protocol.send>) =>
          args[1]._tag === "Request"
            ? Effect.suspend(() =>
                protocol.send(...args).pipe(
                  // URL failure can arrive while a request is entering Effect's
                  // client registry and its writer is already waiting for a
                  // socket. A protocol broadcast does not reliably settle that
                  // registration race. Capture this exact attempt's failure
                  // edge to cancel its blocked write with a fixed typed error;
                  // neither transient recovery nor explicit reconnect may send
                  // this request on a replacement socket.
                  Effect.raceFirst(failedAttemptLatch.await.pipe(Effect.andThen(requestFailure))),
                ),
              )
            : protocol.send(...args),
        run: (clientId, writeResponse) =>
          protocol.run(clientId, (response) => {
            if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              clearAllTrackedRpcRequests();
            }
            return writeResponse(response);
          }),
      }),
    ),
  );
  const requestHooksLayer = Layer.succeed(
    RpcClient.RequestHooks,
    RpcClient.RequestHooks.of({
      onRequestStart: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestStart?.({
            id: String(info.id),
            tag: info.tag,
            stream: info.stream,
          });
          trackRpcRequestSent(String(info.id), info.tag);
        }),
      onRequestChunk: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestChunk?.({
            id: String(info.id),
            tag: info.tag,
            chunkCount: info.chunkCount,
          });
          acknowledgeRpcRequest(String(info.id));
        }),
      onRequestExit: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestExit?.({
            id: String(info.id),
            tag: info.tag,
            stream: info.stream,
          });
          acknowledgeRpcRequest(String(info.id));
        }),
      onRequestInterrupt: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestInterrupt?.({
            id: String(info.id),
            ...(info.tag === undefined ? {} : { tag: info.tag }),
          });
          acknowledgeRpcRequest(String(info.id));
        }),
    }),
  );
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      onConnect: Effect.void,
      // This hook also covers an open deadline or heartbeat timeout without a
      // native error event. Every failure must settle attempt-bound writes even
      // if no RPC client was registered when Effect broadcast the failure.
      onDisconnect: Effect.sync(() => {
        failedAttemptLatch.openUnsafe();
      }),
      onProtocolDefect: Effect.sync(() => {
        // Effect retries typed socket errors, not a local parser/handler
        // defect. Its native finalizer may already have emitted close, but no
        // replacement deadline exists. Publish the actual terminal edge after
        // Effect has fenced currentError and cleared routing; never diagnose
        // it by inspecting a remote payload or expose its possibly private text.
        // Retired sessions and intentional disposal cannot make a current
        // environment demand a manual retry.
        if (lifecycle.isActive() && handlers?.isCloseIntentional?.() !== true) {
          terminalUrlFailure = true;
          lifecycle.onTerminalError(WS_CONNECTION_FAILURE_MESSAGE);
        }
      }),
      onPing: Effect.sync(() => {
        if (lifecycle.isActive()) {
          handlers?.onHeartbeatPing?.();
        }
      }),
      onPong: Effect.flatMap(Effect.serviceOption(Socket.WebSocket), (origin) =>
        Effect.sync(() => {
          // Effect binds the originating native socket to each received-message
          // fiber. A late message from a retired attempt in the same runtime
          // must not mark its replacement healthy or reset that peer's backoff.
          if (lifecycle.isActive() && Option.isSome(origin) && origin.value === activeSocket) {
            // A mere handshake can succeed while the server remains overloaded
            // or half-dead. Only a received protocol Pong proves a healthy peer.
            // Reset this closure rather than Effect's lifetime recurrence count,
            // so successful recovery restores the initial delay while repeated
            // open/missing-Pong cycles continue backing off to the 64-second cap.
            nextRetryIndex = 0;
            handlers?.onHeartbeatPong?.();
          }
        }),
      ),
      onPingTimeout: Effect.sync(() => {
        if (lifecycle.isActive()) {
          clearAllTrackedRpcRequests();
          if (shouldTrackGlobalConnectionStatus(handlers)) {
            recordWsHeartbeatTimeout();
            recordWsConnectionErrored(
              "WebSocket heartbeat timed out.",
              resolveConnectionMetadata(handlers),
            );
          }
          handlers?.onHeartbeatTimeout?.();
        }
      }),
    }),
  );

  return Layer.mergeAll(
    protocolLayer.pipe(
      Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
    ),
    requestHooksLayer,
    connectionHooksLayer,
  );
}
