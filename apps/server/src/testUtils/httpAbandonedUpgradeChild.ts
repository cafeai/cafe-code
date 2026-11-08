// Native, isolated regression peer: only test-owned loopback sockets and the
// actual production adapter are created. No application profile or provider is
// initialized. An uncaught socket error must retain Node's default fatal exit.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The inert peer exercises the actual Node HTTP server and accepted native transports.
import * as Http from "node:http";
// errorMonitor observes the native write failure without consuming the
// baseline's fatal error event.
import { errorMonitor, type EventEmitter } from "node:events";
// Exact native socket ownership is needed for test-only cleanup after handover.
import { Socket } from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as NodeHttpServerCompression from "../nodeHttpServerCompression.ts";

const send = (message: object): void => {
  // The parent can retire between the connected check and this asynchronous
  // write. Consume only this diagnostic IPC completion so cleanup cannot add
  // an unrelated unhandled channel error to the native HTTP regression.
  if (process.connected) process.send?.(message, undefined, undefined, () => {});
};
const failureCode = (error: unknown): string => {
  const field =
    typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, "code")
      : undefined;
  const code = field && "value" in field ? field.value : undefined;
  return code === "EPIPE" || code === "ECONNRESET" ? code : "other";
};
const failureSyscall = (error: unknown): string => {
  const field =
    typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, "syscall")
      : undefined;
  const syscall = field && "value" in field ? field.value : undefined;
  return syscall === "write" || syscall === "writev" ? syscall : "other";
};

type PeerCase = "fin" | "reset";
const peerForPath = (path: string | undefined): PeerCase | undefined =>
  path === "/abandoned-upgrade" ? "fin" : path === "/abandoned-upgrade-reset" ? "reset" : undefined;
// Sequential cases share one bounded, never-mutated response allocation.
const responseBytes = new Uint8Array(16 * 1024 * 1024);
const server = Http.createServer();
const sockets = new Set<Socket>();
let stopping = false;
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const gates = { fin: gate(), reset: gate() };
const caseBySocket = new WeakMap<Socket, PeerCase>();
const caseSockets = new Map<PeerCase, Socket>();
const enteredCases = new Set<PeerCase>();
const backpressuredCases = new Set<PeerCase>();
let resetReleased = false;

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  // errorMonitor observes the real native failure without handling it. The
  // old adapter therefore still crashes rather than receiving a test-created
  // error listener that would accidentally fix the regression itself.
  // Socket inherits EventEmitter's symbol event support at runtime. Its Node
  // type overloads narrow event names to strings, so retain the base event
  // contract for this passive native monitor without changing any behavior.
  (socket as EventEmitter).on(errorMonitor, (error: unknown) => {
    const peerCase = caseBySocket.get(socket);
    send({
      type: "native-error",
      ...(peerCase ? { peerCase } : {}),
      code: failureCode(error),
      syscall: failureSyscall(error),
    });
  });
});
server.prependListener("upgrade", (request, rawSocket) => {
  const peerCase = peerForPath(request.url);
  if (!peerCase) return;
  if (!(rawSocket instanceof Socket) || caseSockets.has(peerCase))
    throw new Error("The inert upgrade case has no unique native socket.");
  const socket = rawSocket;
  caseBySocket.set(socket, peerCase);
  caseSockets.set(peerCase, socket);
  socket.pause();
  send({ type: "native-upgrade", peerCase });
  socket.once("end", () => {
    send({ type: "peer-ended", peerCase });
    if (peerCase === "fin") gates.fin.release();
  });
  socket.once("finish", () => send({ type: "peer-finished", peerCase }));
  socket.once("close", () => send({ type: "peer-closed", peerCase }));
  if (peerCase === "fin") {
    socket.resume();
    return;
  }
  const highWaterMark = socket.readableHighWaterMark;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark <= 0 || highWaterMark > 64 * 1024)
    throw new Error("The inert native read bound is unsupported.");
  const observeBackpressure = (): void => {
    if (
      stopping ||
      socket.destroyed ||
      caseSockets.get("reset") !== socket ||
      backpressuredCases.has("reset")
    )
      return;
    const bufferedBytes = socket.readableLength;
    if (bufferedBytes < highWaterMark) return;
    if (!Number.isSafeInteger(bufferedBytes) || bufferedBytes > 128 * 1024)
      throw new Error("The inert native readable buffer exceeded its bound.");
    // Node24 onStreamRead calls readStop synchronously after push(false),
    // before its deferred readable event. No consumer reads this buffer.
    // Observing its actual HWM is native backpressure, not pause() alone.
    backpressuredCases.add("reset");
    socket.off("readable", observeBackpressure);
    socket.pause();
    send({ type: "read-backpressured", peerCase: "reset", highWaterMark, bufferedBytes });
  };
  socket.on("readable", observeBackpressure);
  socket.once("close", () => socket.off("readable", observeBackpressure));
});

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const peerCase = peerForPath(request.url);
  if (peerCase) {
    if (enteredCases.has(peerCase))
      return yield* Effect.die(new Error("The inert response case was duplicated."));
    enteredCases.add(peerCase);
    send({ type: "route-entered", peerCase });
    yield* Effect.promise(() => gates[peerCase].promise);
    if (stopping) return HttpServerResponse.empty({ status: 503 });
    send({ type: "response-admitted", peerCase });
    // Use the unchanged production Uint8Array response branch. Only this
    // test-owned peer admission differs; no error or write is synthesized.
    return HttpServerResponse.uint8Array(responseBytes, { status: 401 });
  }
  return HttpServerResponse.text("healthy");
});
const runtime = ManagedRuntime.make(
  HttpServer.serve(app).pipe(
    Layer.provideMerge(
      NodeHttpServerCompression.layer(() => server, { host: "127.0.0.1", port: 0 }),
    ),
  ),
);
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  gates.fin.release();
  gates.reset.release();
  // closeAllConnections omits upgraded sockets. Destroy only the exact native
  // sockets admitted by this inert server, then join its scoped native close.
  for (const socket of sockets) socket.destroy();
  await runtime.dispose();
  send({ type: "stopped" });
  if (process.connected) process.disconnect();
};
const stopAfterControl = (): void => {
  void stop().catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
};
// Parent retirement is installed before the first native layer acquisition.
// A disconnected parent cannot leave this test listener detached.
process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null || !("type" in message)) return;
  if (message.type === "stop") return stopAfterControl();
  if (message.type !== "release-response") return;
  const socket = caseSockets.get("reset");
  if (
    stopping ||
    resetReleased ||
    !("peerCase" in message) ||
    message.peerCase !== "reset" ||
    !socket ||
    socket.destroyed ||
    !enteredCases.has("reset") ||
    !backpressuredCases.has("reset")
  )
    throw new Error("The inert reset response release lacks its exact owner.");
  resetReleased = true;
  gates.reset.release();
});
process.once("disconnect", stopAfterControl);

const active = await runtime.runPromise(Effect.service(HttpServer.HttpServer));
if (stopping) {
  await runtime.dispose();
} else if (active.address._tag === "TcpAddress") {
  send({ type: "ready", port: active.address.port });
} else {
  throw new Error("The native HTTP fixture did not acquire a TCP listener.");
}
