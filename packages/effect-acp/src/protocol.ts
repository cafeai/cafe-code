import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
const isAcpError = Schema.is(AcpError.AcpError);

/**
 * ACP can carry embedded images, so the frame ceiling is intentionally larger
 * than Cafe's ordinary orchestration-event ceiling. It is still finite: the
 * peer is a local child process but remains an untrusted protocol boundary.
 */
export const ACP_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const ACP_MAX_PENDING_EXTENSION_REQUESTS = 1_024;
const ACP_SERVER_QUEUE_CAPACITY = 256;
const ACP_CLIENT_QUEUE_CAPACITY = 2_048;
export const ACP_NOTIFICATION_REPLAY_CAPACITY = 2_048;
const ACP_OUTGOING_QUEUE_CAPACITY = 512;
const textEncoder = new TextEncoder();

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params: AcpSchema.SessionNotification;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.session_elicitation_complete;
      readonly params: AcpSchema.ElicitationCompleteNotification;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

export interface AcpPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  /**
   * Best-effort observation stream for decoded inbound notifications.
   *
   * The stream replays a bounded recent tail to late subscribers and drops
   * older observations when a subscriber cannot keep up. Canonical protocol
   * delivery always continues independently through `onNotification`.
   */
  readonly incoming: Stream.Stream<AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
}

interface AcpPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, AcpError.AcpError>;
  readonly method: string;
}

const decodeSessionUpdate = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);
const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.ElicitationCompleteNotification,
);
const parserFactory = RpcSerialization.ndJsonRpc();

function encodedByteLength(value: string | Uint8Array): number {
  return typeof value === "string" ? textEncoder.encode(value).byteLength : value.byteLength;
}

function summarizeDecodedMessage(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return { valueType: typeof value };
  }
  const record = value as Record<string, unknown>;
  const tag = typeof record._tag === "string" ? record._tag : undefined;
  const method = typeof record.tag === "string" ? record.tag : undefined;
  const rawId = record.id ?? record.requestId;
  return {
    ...(tag ? { tag } : {}),
    ...(method ? { method } : {}),
    ...(rawId === undefined || rawId === "" ? {} : { requestIdClass: typeof rawId }),
  };
}

function redactProtocolLogEvent(event: AcpProtocolLogEvent): AcpProtocolLogEvent {
  if (event.stage === "decode_failed") {
    return event;
  }
  if (event.stage === "raw") {
    return {
      ...event,
      payload: {
        byteLength:
          typeof event.payload === "string" || event.payload instanceof Uint8Array
            ? encodedByteLength(event.payload)
            : undefined,
      },
    };
  }
  const values = Array.isArray(event.payload) ? event.payload : [event.payload];
  return {
    ...event,
    payload: {
      messageCount: values.length,
      messages: values.slice(0, 16).map(summarizeDecodedMessage),
      omittedMessages: Math.max(0, values.length - 16),
    },
  };
}

export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = parserFactory.makeUnsafe();
  const serverQueue = yield* Queue.bounded<RpcMessage.FromClientEncoded>(ACP_SERVER_QUEUE_CAPACITY);
  const clientQueue = yield* Queue.bounded<RpcMessage.FromServerEncoded>(ACP_CLIENT_QUEUE_CAPACITY);
  // Raw notifications are an optional observability surface, not a delivery
  // prerequisite. A bounded backpressured Queue here can deadlock the sole
  // stdin reader when no one consumes `incoming`: the queue fills before
  // `onNotification` runs, then the child eventually blocks on its full stdout
  // pipe. Sliding PubSub keeps a useful bounded replay tail without allowing a
  // dormant or slow diagnostic subscriber to stall canonical ACP handling.
  const notificationPubSub = yield* PubSub.sliding<AcpIncomingNotification>({
    capacity: ACP_NOTIFICATION_REPLAY_CAPACITY,
    replay: ACP_NOTIFICATION_REPLAY_CAPACITY,
  });
  const disconnects = yield* Queue.unbounded<number>();
  const outgoing = yield* Queue.bounded<string | Uint8Array, Cause.Done<void>>(
    ACP_OUTGOING_QUEUE_CAPACITY,
  );
  const nextRequestId = yield* Ref.make(1);
  const terminationHandled = yield* Ref.make(false);
  const extPending = yield* Ref.make(new Map<string, AcpPendingRequest>());
  const inputRemainder = yield* Ref.make("");

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(redactProtocolLogEvent(event)) ??
      Effect.logDebug("ACP protocol event").pipe(
        Effect.annotateLogs({ event: redactProtocolLogEvent(event) }),
      )
    );
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(function* (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) {
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: message,
    });

    const method = message._tag === "Request" ? message.tag : undefined;
    const encodedRequestId =
      message._tag === "Request"
        ? message.id
        : "requestId" in message
          ? message.requestId
          : undefined;
    const requestId = encodedRequestId === "" ? undefined : encodedRequestId;
    const encoded = yield* Effect.try({
      try: () => parser.encode(message),
      catch: (cause) => AcpError.AcpProtocolParseError.fromEncodingError(method, requestId, cause),
    });

    if (encoded) {
      yield* logProtocol({
        direction: "outgoing",
        stage: "raw",
        payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
      });

      yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
    }
  });

  const resolveExtPending = (
    requestId: AcpError.AcpRequestId,
    onFound: (pendingRequest: AcpPendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const pendingKey = String(requestId);
      const pendingRequest = pending.get(pendingKey);
      if (!pendingRequest) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return [onFound(pendingRequest), next] as const;
    }).pipe(Effect.flatten);

  const removeExtPending = (requestId: AcpError.AcpRequestId) =>
    Ref.update(extPending, (pending) => {
      const pendingKey = String(requestId);
      if (!pending.has(pendingKey)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return next;
    });

  const completeExtPendingFailure = (requestId: AcpError.AcpRequestId, error: AcpError.AcpError) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.fail(deferred, error));

  const completeExtPendingSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.succeed(deferred, value));

  const failAllExtPending = (error: AcpError.AcpError) =>
    Ref.getAndSet(extPending, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    PubSub.publish(notificationPubSub, notification).pipe(
      Effect.andThen(
        options.onNotification
          ? options.onNotification(notification).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const emitClientProtocolError = (error: AcpError.AcpError) =>
    Queue.offer(clientQueue, {
      _tag: "ClientProtocolError",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "ACP protocol terminated.",
          cause: error,
        }),
      }),
    }).pipe(Effect.asVoid);

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError | undefined>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Queue.offer(disconnects, 0);
          const error = yield* classify();
          if (!error) {
            return;
          }
          yield* failAllExtPending(error);
          yield* emitClientProtocolError(error);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId: String(requestId),
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: AcpError.AcpRequestId, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId: String(requestId),
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options.onExtRequest(message.tag, message.payload).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          respondWithError(
            message.id,
            AcpError.AcpRequestError.fromExtensionHandlerError(error, message.tag),
          ),
        onSuccess: (value) => respondWithSuccess(message.id, value),
      }),
    );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_update,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      if (message.tag === CLIENT_METHODS.session_elicitation_complete) {
        return decodeElicitationComplete(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "ElicitationComplete",
                method: CLIENT_METHODS.session_elicitation_complete,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_elicitation_complete,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    if (!options.serverRequestMethods.has(message.tag)) {
      return handleExtRequest(message).pipe(
        Effect.catchTag("AcpProtocolParseError", (error) =>
          Effect.logWarning(error).pipe(
            Effect.annotateLogs({
              method: message.tag,
              requestId: message.id,
              operation: error.operation,
            }),
            Effect.andThen(
              respondWithError(
                message.id,
                AcpError.AcpRequestError.fromExtensionResponseEncodingError(
                  message.tag,
                  message.id,
                  error,
                ),
              ),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }

    return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
  };

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) =>
    Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        const pendingRequest = pending.get(String(message.requestId));
        if (!pendingRequest) {
          return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
        }
        if (message.exit._tag === "Success") {
          return completeExtPendingSuccess(message.requestId, message.exit.value);
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        if (failure && isProtocolError(failure.error)) {
          return completeExtPendingFailure(
            message.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure.error, {
              method: pendingRequest.method,
              requestId: message.requestId,
            }),
          );
        }
        return completeExtPendingFailure(
          message.requestId,
          AcpError.AcpRequestError.fromExtensionResponseFailure(
            pendingRequest.method,
            message.requestId,
            message.exit.cause,
          ),
        );
      }),
    );

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) => {
            const pendingRequest = pending.get(String(message.requestId));
            return pendingRequest
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.unsupportedStreamingResponse(
                    pendingRequest.method,
                    message.requestId,
                  ),
                )
              : Queue.offer(clientQueue, message).pipe(Effect.asVoid);
          }),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
    }
  };

  const decodeAndRouteLine = (line: string): Effect.Effect<void, AcpError.AcpError> => {
    if (line.trim().length === 0) {
      return Effect.void;
    }
    const lineByteLength = encodedByteLength(line);
    if (lineByteLength > ACP_MAX_MESSAGE_BYTES) {
      return Effect.fail(
        new AcpError.AcpProtocolParseError({
          operation: "decode-wire-message",
          cause: new Error(
            `ACP message exceeded the ${ACP_MAX_MESSAGE_BYTES}-byte limit (${lineByteLength} bytes).`,
          ),
        }),
      );
    }
    return logProtocol({
      direction: "incoming",
      stage: "raw",
      payload: line,
    }).pipe(
      Effect.flatMap(() =>
        Effect.try({
          try: () =>
            parser.decode(`${line}\n`) as ReadonlyArray<
              RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
            >,
          catch: (cause) =>
            new AcpError.AcpProtocolParseError({
              operation: "decode-wire-message",
              cause,
            }),
        }),
      ),
      Effect.tap((messages) =>
        logProtocol({
          direction: "incoming",
          stage: "decoded",
          payload: messages,
        }),
      ),
      Effect.tapError((error) =>
        logProtocol({
          direction: "incoming",
          stage: "decode_failed",
          payload: {
            operation: error.operation,
            ...(error.method === undefined ? {} : { method: error.method }),
            ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
            ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
            ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
            ...(error.maximumPathDepth === undefined
              ? {}
              : { maximumPathDepth: error.maximumPathDepth }),
          },
        }),
      ),
      Effect.flatMap((messages) =>
        Effect.forEach(messages, routeDecodedMessage, {
          discard: true,
        }),
      ),
    );
  };

  const consumeInputChunk = (chunk: string): Effect.Effect<void, AcpError.AcpError> =>
    Ref.modify(inputRemainder, (current) => {
      const lines = `${current}${chunk}`.split("\n");
      const remainder = lines.pop() ?? "";
      return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
    }).pipe(
      Effect.flatMap((lines) =>
        Ref.get(inputRemainder).pipe(
          Effect.flatMap((remainder) =>
            encodedByteLength(remainder) > ACP_MAX_MESSAGE_BYTES
              ? Effect.fail(
                  new AcpError.AcpProtocolParseError({
                    operation: "decode-wire-message",
                    cause: new Error(
                      `ACP partial message exceeded the ${ACP_MAX_MESSAGE_BYTES}-byte limit.`,
                    ),
                  }),
                )
              : Effect.forEach(lines, decodeAndRouteLine, { discard: true }),
          ),
        ),
      ),
    );

  yield* options.stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runForEach(consumeInputChunk),
    Effect.matchEffect({
      onFailure: (error) => {
        const normalized: AcpError.AcpError = isAcpError(error)
          ? error
          : new AcpError.AcpTransportError({
              operation: "read-input-stream",
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        Ref.get(inputRemainder).pipe(
          Effect.flatMap((line) => decodeAndRouteLine(line.replace(/\r$/, ""))),
          Effect.matchEffect({
            onFailure: (error) => handleTermination(() => Effect.succeed(error)),
            onSuccess: () =>
              handleTermination(
                () =>
                  options.terminationError ??
                  Effect.succeed(new AcpError.AcpInputStreamEndedError({})),
              ),
          }),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

  const clientProtocol = RpcClient.Protocol.of({
    run: (_clientId, f) =>
      Stream.fromQueue(clientQueue).pipe(
        Stream.runForEach((message) => f(message)),
        Effect.forever,
      ),
    send: (_clientId, request) =>
      offerOutgoing(request).pipe(
        Effect.mapError(
          (error) =>
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "Failed to send ACP protocol message.",
                cause: error,
              }),
            }),
        ),
      ),
    supportsAck: true,
    supportsTransferables: false,
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: (f) =>
      Stream.fromQueue(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.forever,
      ),
    disconnects,
    send: (_clientId, response) => offerOutgoing(response).pipe(Effect.orDie),
    end: (_clientId) => Queue.end(outgoing),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
  });

  const sendNotification = Effect.fn("sendNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    yield* offerOutgoing({
      _tag: "Request",
      id: "",
      tag: method,
      payload,
      headers: [],
    });
  });

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1] as const,
    );
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    const registered = yield* Ref.modify(extPending, (pending) => {
      if (pending.size >= ACP_MAX_PENDING_EXTENSION_REQUESTS) {
        return [false, pending] as const;
      }
      return [true, new Map(pending).set(String(requestId), { deferred, method })] as const;
    });
    if (!registered) {
      return yield* Effect.fail(
        AcpError.AcpRequestError.overloaded("Too many pending ACP extension requests."),
      );
    }
    yield* offerOutgoing({
      _tag: "Request",
      id: String(requestId),
      tag: method,
      payload,
      headers: [],
    }).pipe(Effect.tapError(() => removeExtPending(requestId)));
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => removeExtPending(requestId)),
    );
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return Stream.fromPubSub(notificationPubSub);
    },
    request: sendRequest,
    notify: sendNotification,
  } satisfies AcpPatchedProtocol;
});

function isProtocolError(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
