import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);

const RAW_INCOMING_NOTIFICATION_QUEUE_CAPACITY = 2_048;
const RAW_INCOMING_REQUEST_QUEUE_CAPACITY = 256;
const MAX_PROTOCOL_DIAGNOSTIC_LENGTH = 8_000;

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

function summarizeUnknownProtocolMessage(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {
      valueType: typeof value,
    };
  }

  const keys = Object.keys(value).toSorted();
  return {
    keys,
    hasId: "id" in value,
    hasMethod: "method" in value,
    method: typeof value.method === "string" ? value.method : null,
    idType: "id" in value ? typeof value.id : null,
  };
}

function truncateDiagnostic(input: string): string {
  if (input.length <= MAX_PROTOCOL_DIAGNOSTIC_LENGTH) {
    return input;
  }
  return `${input.slice(0, MAX_PROTOCOL_DIAGNOSTIC_LENGTH)}...<truncated>`;
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError(
      (cause) =>
        new CodexError.CodexAppServerProtocolParseError({
          detail: "Failed to encode Codex App Server message",
          cause,
        }),
    ),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError(
      (cause) =>
        new CodexError.CodexAppServerProtocolParseError({
          detail: "Failed to decode Codex App Server wire message",
          cause,
        }),
    ),
  );

const normalizeIncomingError = (error: unknown, detail: string): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        detail,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const protocolScope = yield* Scope.Scope;
    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
    const incomingNotifications = yield* Queue.sliding<CodexAppServerIncomingNotification>(
      RAW_INCOMING_NOTIFICATION_QUEUE_CAPACITY,
    );
    const incomingRequests = yield* Queue.sliding<CodexAppServerIncomingRequest>(
      RAW_INCOMING_REQUEST_QUEUE_CAPACITY,
    );
    const pending = yield* Ref.make(
      new Map<string, Deferred.Deferred<unknown, CodexError.CodexAppServerError>>(),
    );
    const nextRequestId = yield* Ref.make(1);
    const remainder = yield* Ref.make("");
    const terminationHandled = yield* Ref.make(false);

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (
        event.direction === "incoming" &&
        !options.logIncoming &&
        event.stage !== "decode_failed"
      ) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], (deferred) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* logProtocol({
          direction: "outgoing",
          stage: "decoded",
          payload: message,
        });
        const encoded = yield* encodeWireMessage(message);
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: encoded,
        });
        yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (
        deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>,
      ) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const deferred = current.get(requestId);
        if (!deferred) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(deferred), next] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, (deferred) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(protocolError),
          ),
        );
      }
      return resolvePending(requestId, (deferred) => Deferred.succeed(deferred, response.result));
    };

    const runRequestHandler = (request: CodexAppServerIncomingRequest) => {
      if (!options.onRequest) {
        return Effect.void;
      }

      // Codex can send approval/user-input requests while it continues to emit
      // notifications. The official client detaches request waits from its
      // event loop; doing the same here prevents a pending UI decision from
      // blocking all later stdout JSON-RPC messages.
      return options.onRequest(request).pipe(
        Effect.matchEffect({
          onFailure: (error) => respondError(request.id, CodexError.normalizeToRequestError(error)),
          onSuccess: (result) => respond(request.id, result),
        }),
        Effect.catchCause((cause) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              detail: "Codex App Server request dispatch failed",
              method: request.method,
              idType: typeof request.id,
              cause: truncateDiagnostic(Cause.pretty(cause)),
            },
          }).pipe(
            Effect.andThen(
              respondError(
                request.id,
                CodexError.CodexAppServerRequestError.internalError(
                  "Codex App Server request handler failed",
                ),
              ).pipe(
                Effect.catchCause((respondCause) =>
                  logProtocol({
                    direction: "outgoing",
                    stage: "decode_failed",
                    payload: {
                      detail: "Codex App Server request error response failed",
                      method: request.method,
                      idType: typeof request.id,
                      cause: truncateDiagnostic(Cause.pretty(respondCause)),
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    };

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Queue.offer(incomingRequests, request).pipe(
        Effect.andThen(
          options.onRequest
            ? runRequestHandler(request).pipe(Effect.forkIn(protocolScope), Effect.asVoid)
            : Effect.void,
        ),
        Effect.asVoid,
      );

    const runNotificationHandler = (notification: CodexAppServerIncomingNotification) =>
      options.onNotification
        ? options.onNotification(notification).pipe(
            Effect.catchCause((cause) =>
              logProtocol({
                direction: "incoming",
                stage: "decode_failed",
                payload: {
                  detail: "Codex App Server notification dispatch failed",
                  method: notification.method,
                  cause: truncateDiagnostic(Cause.pretty(cause)),
                },
              }),
            ),
          )
        : Effect.void;

    const handleNotification = (notification: CodexAppServerIncomingNotification) =>
      Queue.offer(incomingNotifications, notification).pipe(
        Effect.andThen(
          // Notifications can trigger renderer projection, disk writes, and
          // schema fallback handling. The JSON-RPC stdin reader must keep
          // draining responses even if one notification handler is slow or
          // waiting on the UI; otherwise a later response to `turn/start` or
          // `thread/read` can be trapped behind unrelated notification work.
          options.onNotification
            ? runNotificationHandler(notification).pipe(Effect.forkIn(protocolScope), Effect.asVoid)
            : Effect.void,
        ),
        Effect.asVoid,
      );

    const routeMessage = (
      message: unknown,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (isIncomingRequest(message)) {
        return handleRequest(message);
      }
      if (isIncomingNotification(message)) {
        return handleNotification(message);
      }
      if (isIncomingResponse(message)) {
        return handleResponse(message);
      }
      return Effect.fail(
        new CodexError.CodexAppServerProtocolParseError({
          detail: "Received protocol message in an unknown shape",
          cause: summarizeUnknownProtocolMessage(message),
        }),
      );
    };

    const handleLine = (line: string): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(line)),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.flatMap(routeMessage),
        Effect.catchTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              detail: error.detail,
              cause: error.cause,
              lineByteLength: Buffer.byteLength(line, "utf8"),
            },
          }),
        ),
      );
    };

    yield* options.stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(remainder, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const nextRemainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), nextRemainder] as const;
        }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, handleLine, { discard: true }))),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(error, "Codex App Server input stream failed")),
          ),
        onSuccess: () =>
          Ref.get(remainder).pipe(
            Effect.flatMap((line) => (line.trim().length === 0 ? Effect.void : handleLine(line))),
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(error)),
              onSuccess: () =>
                handleTermination(
                  () =>
                    options.terminationError ??
                    Effect.succeed(
                      new CodexError.CodexAppServerTransportError({
                        detail: "Codex App Server input stream ended",
                        cause: new Error("Codex App Server input stream ended"),
                      }),
                    ),
                ),
            }),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

    const request = (method: string, payload?: unknown) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        yield* Ref.update(pending, (current) => new Map(current).set(String(requestId), deferred));
        yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(
          Effect.catch((error) =>
            removePending(String(requestId)).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() => removePending(String(requestId))),
        );
      });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromQueue(incomingNotifications),
      incomingRequests: Stream.fromQueue(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);
