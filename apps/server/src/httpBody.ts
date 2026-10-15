// @effect-diagnostics nodeBuiltinImport:off
import { IncomingMessage } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export class HttpBodyError extends Data.TaggedError("HttpBodyError")<{
  readonly status: 400 | 408 | 413 | 503;
}> {}

// Reserve the whole admitted ceiling, so simultaneous small chunks cannot
// evade the aggregate materialization budget. Uploads retain their own limits.
let activeReaders = 0;
let reservedBytes = 0;
const MAX_RESERVED_BYTES = 32 * 1024 * 1024;
export const CONTROL_BODY_BYTES = 64 * 1024;
export const MCP_BODY_BYTES = 1024 * 1024;

const collect = (chunks: readonly Uint8Array[], size: number) => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const retireNativeBody = (
  request: HttpServerRequest.HttpServerRequest,
  native: IncomingMessage,
) => {
  native.pause();
  const response = NodeHttpServerRequest.toServerResponse(request);
  // Body admission may fail before a route installs its error response. Retire
  // the unread socket regardless of how that route maps the error to HTTP.
  response.shouldKeepAlive = false;
  const close = () => {
    clearTimeout(timer);
    response.off("finish", close);
    response.off("close", close);
    native.destroy();
  };
  const timer = setTimeout(close, 1000);
  timer.unref();
  response.once("finish", close);
  response.once("close", close);
  if (response.writableFinished || response.destroyed) close();
};

const readNativeBody = (
  request: HttpServerRequest.HttpServerRequest,
  native: IncomingMessage,
  maxBytes: number,
) =>
  Effect.callback<Uint8Array, HttpBodyError>((resume) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let finished = false;
    const cleanup = () => {
      native.off("data", onData);
      native.off("end", onEnd);
      native.off("error", onError);
      native.off("aborted", onError);
    };
    const fail = (status: 400 | 413) => {
      if (finished) return;
      finished = true;
      cleanup();
      retireNativeBody(request, native);
      resume(Effect.fail(new HttpBodyError({ status })));
    };
    function onData(chunk: Buffer) {
      if (size + chunk.byteLength > maxBytes || chunks.length >= 2048) {
        fail(413);
        return;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    function onEnd() {
      if (finished) return;
      finished = true;
      cleanup();
      resume(Effect.succeed(collect(chunks, size)));
    }
    function onError() {
      fail(400);
    }
    native.on("data", onData);
    native.once("end", onEnd);
    native.once("error", onError);
    native.once("aborted", onError);
    if (native.readableEnded) onEnd();
    else native.resume();
    return Effect.sync(() => {
      cleanup();
      if (!finished) {
        finished = true;
        retireNativeBody(request, native);
      }
    });
  });

export const readHttpBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
  deadlineMs = 10_000,
) =>
  Effect.acquireUseRelease(
    Effect.suspend(() => {
      const refuse = (status: 413 | 503) => {
        if (request.source instanceof IncomingMessage) retireNativeBody(request, request.source);
        return Effect.fail(new HttpBodyError({ status }));
      };
      const declared = request.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))
        return refuse(413);
      if (activeReaders >= 32 || reservedBytes + maxBytes > MAX_RESERVED_BYTES) return refuse(503);
      activeReaders++;
      reservedBytes += maxBytes;
      return Effect.void;
    }),
    () =>
      (request.source instanceof IncomingMessage
        ? readNativeBody(request, request.source, maxBytes)
        : request.stream.pipe(
            Stream.runFoldEffect(
              () => ({ chunks: [] as Uint8Array[], size: 0 }),
              (state, chunk) => {
                if (state.size + chunk.byteLength > maxBytes || state.chunks.length >= 2048)
                  return Effect.fail(new HttpBodyError({ status: 413 }));
                state.chunks.push(chunk);
                state.size += chunk.byteLength;
                return Effect.succeed(state);
              },
            ),
            Effect.map(({ chunks, size }) => collect(chunks, size)),
            Effect.mapError((error) =>
              error instanceof HttpBodyError ? error : new HttpBodyError({ status: 400 }),
            ),
          )
      ).pipe(
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () => Effect.fail(new HttpBodyError({ status: 408 })),
        }),
      ),
    () =>
      Effect.sync(() => {
        activeReaders--;
        reservedBytes -= maxBytes;
      }),
  );

export const readHttpJson = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes = CONTROL_BODY_BYTES,
) =>
  readHttpBody(request, maxBytes).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: (): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        // No parser message or cause: engines may include secret-bearing input.
        catch: () => new HttpBodyError({ status: 400 }),
      }),
    ),
  );

export const readControlJson = <S extends Schema.Top>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* readHttpJson(request);
    return yield* Schema.decodeUnknownEffect(schema)(body);
  });

export const boundedWebRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const bytes = yield* readHttpBody(request, MCP_BODY_BYTES);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return yield* new HttpBodyError({ status: 400 });
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Request(url.value, { method: request.method, headers, body: bytes });
  });

export const respondToHttpBodyError = (error: HttpBodyError) =>
  Effect.succeed(
    HttpServerResponse.text("Request body refused.", {
      status: error.status,
      headers: { connection: "close", "cache-control": "no-store" },
    }),
  );
