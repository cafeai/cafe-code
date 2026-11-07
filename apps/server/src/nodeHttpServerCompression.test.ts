// The regression owns an inert native child because the missing Socket error
// owner terminates Node. A parent-process uncaughtException handler would hide
// precisely the failure this test must detect.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The regression owns real loopback HTTP requests and their native close events.
import * as Http from "node:http";
// A native TCP FIN and failed write, rather than synthetic error emission,
// protect this transport boundary.
import * as Net from "node:net";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The expected baseline crash must be contained in an exact test-owned native child.
import { spawn, type ChildProcess } from "node:child_process";
// Native spawn requires the exact local file path of the inert child entry.
import { fileURLToPath } from "node:url";
import { assert, it, type TestContext } from "vitest";

type Phase =
  | "ready"
  | "native-upgrade"
  | "route-entered"
  | "peer-ended"
  | "response-admitted"
  | "native-error"
  | "peer-closed"
  | "stopped";
interface Observation {
  readonly type: Phase;
  readonly port?: number;
  readonly code?: "EPIPE" | "ECONNRESET" | "other";
  readonly syscall?: "write" | "writev" | "other";
}
interface NativeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function nativeUpgradeFixture(context: TestContext) {
  let retired = false;
  let child: ChildProcess | undefined;
  let exited: NativeExit | undefined;
  let closePromise: Promise<NativeExit | undefined> | undefined;
  let nativeClose: Promise<NativeExit> | undefined;
  const observations: Observation[] = [];
  const sockets = new Set<Net.Socket>();
  const requests = new Set<Http.ClientRequest>();
  const socketCloses: Promise<void>[] = [];
  const requestCloses: Promise<void>[] = [];
  const operations = new Set<Promise<unknown>>();
  const waiters = new Set<{
    readonly type: Phase;
    readonly resolve: (observation: Observation) => void;
    readonly reject: (error: Error) => void;
  }>();
  const retiredError = () => new Error("The native HTTP fixture has retired.");
  const assertLive = () => {
    if (retired || context.signal.aborted) throw retiredError();
  };
  const ownSocket = (socket: Net.Socket): void => {
    sockets.add(socket);
    socketCloses.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
    if (retired) socket.destroy();
  };
  const track = <A>(operation: Promise<A>): Promise<A> => {
    const tracked = operation.finally(() => operations.delete(tracked));
    operations.add(tracked);
    void tracked.catch(() => undefined);
    return tracked;
  };
  const failWaiters = (error: Error): void => {
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  const close = (): Promise<NativeExit | undefined> => {
    retired = true;
    closePromise ??= (async () => {
      failWaiters(retiredError());
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      if (child && !exited) {
        if (child.connected) child.send({ type: "stop" }, () => {});
        else child.kill("SIGTERM");
      }
      // Request close fences any late socket assignment. Only then snapshot
      // and join all exact parent sockets, and the actual child's close event.
      await Promise.all(requestCloses);
      const result = await nativeClose;
      await Promise.all(socketCloses);
      await Promise.allSettled([...operations]);
      context.signal.removeEventListener("abort", onAbort);
      return result;
    })();
    return closePromise;
  };
  const onAbort = (): void => {
    retired = true;
    // A hard test timeout cannot wait for its own stuck fixture controller.
    // This is only our retained inert child handle, never a provider or PID.
    if (child && !exited) child.kill("SIGTERM");
    void close().catch(() => undefined);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFinished(async () => {
    await close();
  });

  assertLive();
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./testUtils/httpAbandonedUpgradeChild.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const owner = child;
  // Drain without retaining raw error text, paths or arbitrary child payloads.
  owner.stdout?.resume();
  owner.stderr?.resume();
  nativeClose = new Promise<NativeExit>((resolve) => {
    owner.once("close", (code, signal) => {
      exited = { code, signal };
      const fault = observations.find((observation) => observation.type === "native-error");
      failWaiters(
        new Error(
          `Native HTTP child closed: code=${String(code)}, signal=${signal ?? "none"}, transport=${fault?.code ?? "unobserved"}/${fault?.syscall ?? "unobserved"}.`,
        ),
      );
      resolve(exited);
    });
  });
  owner.once("error", () => failWaiters(new Error("The native HTTP child could not start.")));
  owner.on("message", (value: unknown) => {
    if (retired || typeof value !== "object" || value === null || !("type" in value)) return;
    const type = value.type;
    if (
      ![
        "ready",
        "native-upgrade",
        "route-entered",
        "peer-ended",
        "response-admitted",
        "native-error",
        "peer-closed",
        "stopped",
      ].includes(type as string) ||
      observations.length >= 32
    ) {
      failWaiters(new Error("The native HTTP fixture protocol was invalid."));
      return;
    }
    const observation: Observation = {
      type: type as Phase,
      ...(type === "ready" && "port" in value && typeof value.port === "number"
        ? { port: value.port }
        : {}),
      ...(type === "native-error" && "code" in value && "syscall" in value
        ? {
            code: value.code === "EPIPE" || value.code === "ECONNRESET" ? value.code : "other",
            syscall:
              value.syscall === "write" || value.syscall === "writev" ? value.syscall : "other",
          }
        : {}),
    };
    observations.push(observation);
    for (const waiter of waiters) {
      if (waiter.type !== observation.type) continue;
      waiters.delete(waiter);
      waiter.resolve(observation);
    }
  });

  const waitFor = (type: Phase): Promise<Observation> => {
    assertLive();
    const observation = observations.find((item) => item.type === type);
    if (observation) return Promise.resolve(observation);
    if (exited) return Promise.reject(new Error("The native HTTP child has already closed."));
    return track(
      new Promise<Observation>((resolve, reject) => waiters.add({ type, resolve, reject })),
    );
  };
  return {
    waitFor,
    close,
    openAbandonedUpgrade(port: number): Net.Socket {
      assertLive();
      const socket = Net.connect({ host: "127.0.0.1", port }, () => {
        if (retired) return socket.destroy();
        socket.write(
          "GET /abandoned-upgrade HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      ownSocket(socket);
      socket.on("error", () => {});
      socket.resume();
      return socket;
    },
    requestHealthy(
      port: number,
    ): Promise<{ readonly status: number | undefined; readonly text: string }> {
      assertLive();
      return track(
        new Promise((resolve, reject) => {
          const request = Http.get(
            { host: "127.0.0.1", port, path: "/healthy", agent: false },
            (response) => {
              if (retired) {
                response.destroy();
                reject(retiredError());
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 1024) {
                  response.destroy();
                  reject(new Error("The native HTTP fixture response exceeded its bound."));
                } else chunks.push(chunk);
              });
              response.once("end", () =>
                resolve({
                  status: response.statusCode,
                  text: Buffer.concat(chunks).toString("utf8"),
                }),
              );
              response.once("error", () =>
                reject(new Error("The native HTTP fixture response failed.")),
              );
              response.once("close", () => {
                if (!response.complete)
                  reject(new Error("The native HTTP fixture response closed early."));
              });
            },
          );
          requests.add(request);
          request.once("socket", ownSocket);
          requestCloses.push(
            new Promise<void>((resolveClose) =>
              request.once("close", () => {
                requests.delete(request);
                resolveClose();
              }),
            ),
          );
          request.once("error", () =>
            reject(new Error("The independent healthy HTTP request failed.")),
          );
          if (retired) request.destroy();
        }),
      );
    },
  };
}

it("survives a real failed upgrade write and still serves an independent HTTP request", async (context) => {
  const fixture = nativeUpgradeFixture(context);
  const ready = await fixture.waitFor("ready");
  assert.isNumber(ready.port);
  const port = ready.port!;
  assert.isTrue(Number.isInteger(port) && port > 0 && port <= 65535);
  const peer = fixture.openAbandonedUpgrade(port);
  await fixture.waitFor("route-entered");
  // Gracefully send the real TCP FIN, then abandon the read side. The server
  // releases its held rejection only when that FIN arrives on its exact peer.
  peer.end();
  peer.destroySoon();
  const failure = await fixture.waitFor("native-error");
  assert.oneOf(failure.code, ["EPIPE", "ECONNRESET"]);
  assert.oneOf(failure.syscall, ["write", "writev"]);
  await fixture.waitFor("peer-closed");
  assert.deepEqual(await fixture.requestHealthy(port), { status: 200, text: "healthy" });
  assert.deepEqual(await fixture.close(), { code: 0, signal: null });
});
