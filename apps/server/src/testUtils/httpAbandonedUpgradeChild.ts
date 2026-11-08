// Native, isolated regression peer: only test-owned loopback sockets and the
// actual production adapter are created. No application profile or provider is
// initialized. An uncaught socket error must retain Node's default fatal exit.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The inert peer exercises the actual Node HTTP server and accepted native transports.
import * as Http from "node:http";
// errorMonitor observes the native write failure without consuming the
// baseline's fatal error event.
import { errorMonitor, type EventEmitter } from "node:events";
// Exact native socket ownership is needed for test-only cleanup after handover.
import type { Socket } from "node:net";
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

const server = Http.createServer();
const sockets = new Set<Socket>();
let stopping = false;
let release!: () => void;
const responseGate = new Promise<void>((resolve) => {
  release = resolve;
});

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
    send({ type: "native-error", code: failureCode(error), syscall: failureSyscall(error) });
  });
});
server.prependListener("upgrade", (request, socket) => {
  if (request.url !== "/abandoned-upgrade") return;
  send({ type: "native-upgrade" });
  socket.once("end", () => {
    // Release directly from native FIN observation, before socket close. An
    // IPC round trip here could let close win and turn the response into an
    // ignored write to an already-destroyed socket instead of a pending write.
    send({ type: "peer-ended" });
    release();
  });
  socket.once("close", () => send({ type: "peer-closed" }));
  // The rejected upgrade has no WebSocket reader. This exact test peer owns
  // draining its empty request stream so the real TCP FIN can be observed.
  socket.resume();
});

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.url === "/abandoned-upgrade") {
    send({ type: "route-entered" });
    yield* Effect.promise(() => responseGate);
    if (stopping) return HttpServerResponse.empty({ status: 503 });
    send({ type: "response-admitted" });
    // Keep a real native write pending after peer closure. The small-response
    // FIN race need not fail on every host; this bounded inert payload proved
    // the same unowned Socket error boundary without synthetic emit/errors.
    return HttpServerResponse.uint8Array(new Uint8Array(16 * 1024 * 1024), { status: 401 });
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
  release();
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
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "stop"
  )
    stopAfterControl();
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
