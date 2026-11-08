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

type PeerCase = "fin" | "reset";
type Phase =
  | "ready"
  | "native-upgrade"
  | "route-entered"
  | "peer-ended"
  | "read-backpressured"
  | "peer-finished"
  | "response-admitted"
  | "native-error"
  | "peer-closed"
  | "stopped";
interface Observation {
  readonly type: Phase;
  readonly peerCase?: PeerCase;
  readonly highWaterMark?: number;
  readonly bufferedBytes?: number;
  readonly port?: number;
  readonly code?: "EPIPE" | "ECONNRESET" | "other";
  readonly syscall?: "write" | "writev" | "other";
}
interface NativeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
type FixturePhase =
  | Phase
  | "starting"
  | "fin-sent"
  | "first-response-data"
  | "reset-requested"
  | "client-close"
  | "healthy-response"
  | "child-close";

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
  const pendingAbandonments = new Set<(error: Error) => void>();
  const peers = new Map<
    PeerCase,
    { readonly socket: Net.Socket; readonly begin: () => Promise<void>; readonly pad: () => void }
  >();
  let waitingFor: FixturePhase = "ready";
  let waitingCase: PeerCase | undefined;
  let observedPhase: FixturePhase = "starting";
  let observedCase: PeerCase | undefined;
  let failureReported = false;
  const reportFailure = (): void => {
    if (failureReported) return;
    failureReported = true;
    // The bounded protocol contains only fixed phase/case enums and counters.
    process.stderr.write(
      "[Cafe Code HTTP fixture] waiting=" +
        waitingFor +
        "/" +
        (waitingCase ?? "global") +
        " observed=" +
        observedPhase +
        "/" +
        (observedCase ?? "global") +
        " sequence=" +
        observations.map((entry) => entry.type + "/" + (entry.peerCase ?? "global")).join(",") +
        "\n",
    );
  };
  const waiters = new Set<{
    readonly type: Phase;
    readonly peerCase?: PeerCase;
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
      for (const reject of pendingAbandonments) reject(retiredError());
      pendingAbandonments.clear();
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
    reportFailure();
    retired = true;
    // A hard test timeout cannot wait for its own stuck fixture controller.
    // This is only our retained inert child handle, never a provider or PID.
    if (child && !exited) child.kill("SIGTERM");
    void close().catch(() => undefined);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFailed(reportFailure);
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
      observedPhase = "child-close";
      const fault = observations.find(
        (observation) =>
          observation.type === "native-error" && observation.peerCase === waitingCase,
      );
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
        "read-backpressured",
        "peer-finished",
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
    const peerCase =
      "peerCase" in value && (value.peerCase === "fin" || value.peerCase === "reset")
        ? value.peerCase
        : undefined;
    const globalPhase = type === "ready" || type === "stopped";
    if (globalPhase ? "peerCase" in value : peerCase === undefined) {
      failWaiters(new Error("The native HTTP fixture case was invalid."));
      return;
    }
    const observation: Observation = {
      type: type as Phase,
      ...(peerCase !== undefined ? { peerCase } : {}),
      ...(type === "read-backpressured" &&
      "highWaterMark" in value &&
      "bufferedBytes" in value &&
      typeof value.highWaterMark === "number" &&
      Number.isSafeInteger(value.highWaterMark) &&
      value.highWaterMark > 0 &&
      value.highWaterMark <= 64 * 1024 &&
      typeof value.bufferedBytes === "number" &&
      Number.isSafeInteger(value.bufferedBytes) &&
      value.bufferedBytes >= value.highWaterMark &&
      value.bufferedBytes <= 128 * 1024
        ? { highWaterMark: value.highWaterMark, bufferedBytes: value.bufferedBytes }
        : {}),
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
    observedPhase = observation.type;
    observedCase = observation.peerCase;
    observations.push(observation);
    for (const waiter of waiters) {
      if (waiter.type !== observation.type || waiter.peerCase !== observation.peerCase) continue;
      waiters.delete(waiter);
      waiter.resolve(observation);
    }
  });

  const waitFor = (type: Phase, peerCase?: PeerCase): Promise<Observation> => {
    assertLive();
    waitingFor = type;
    waitingCase = peerCase;
    const observation = observations.find(
      (item) => item.type === type && item.peerCase === peerCase,
    );
    if (observation) return Promise.resolve(observation);
    if (exited) return Promise.reject(new Error("The native HTTP child has already closed."));
    return track(
      new Promise<Observation>((resolve, reject) =>
        waiters.add({ type, ...(peerCase !== undefined ? { peerCase } : {}), resolve, reject }),
      ),
    );
  };
  return {
    waitFor,
    close,
    openUpgrade(port: number, peerCase: PeerCase): Net.Socket {
      assertLive();
      if (peers.has(peerCase)) throw new Error("The native HTTP case already owns a peer.");
      let finSent = false;
      let resetRequested = false;
      let padded = false;
      let settled = false;
      let resolveAbandonment!: () => void;
      let rejectAbandonment!: (error: Error) => void;
      let paddingCompletion: Promise<void> = Promise.resolve();
      const abandoned = track(
        new Promise<void>((resolve, reject) => {
          resolveAbandonment = resolve;
          rejectAbandonment = reject;
        }),
      );
      const refuseAbandonment = (error: Error): void => {
        if (settled) return;
        settled = true;
        pendingAbandonments.delete(refuseAbandonment);
        rejectAbandonment(error);
        failWaiters(error);
      };
      pendingAbandonments.add(refuseAbandonment);
      const socket = Net.connect({ host: "127.0.0.1", port }, () => {
        if (retired) return socket.destroy();
        const path = peerCase === "fin" ? "/abandoned-upgrade" : "/abandoned-upgrade-reset";
        socket.write(
          "GET " +
            path +
            " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      ownSocket(socket);
      socket.once("data", (chunk: Buffer) => {
        if (settled) return;
        if (
          retired ||
          context.signal.aborted ||
          peers.get(peerCase)?.socket !== socket ||
          !sockets.has(socket) ||
          socket.destroyed
        )
          return refuseAbandonment(retiredError());
        if (peerCase !== "fin" || !finSent || !Buffer.isBuffer(chunk) || chunk.length === 0)
          return refuseAbandonment(new Error("The native response arrived outside FIN admission."));
        observedPhase = "first-response-data";
        observedCase = peerCase;
        // Keep FIN on its own peer. Ordinary destroy never mixes uv_shutdown
        // and uv_tcp_close_reset on the same native connection.
        socket.destroy();
        settled = true;
        pendingAbandonments.delete(refuseAbandonment);
        resolveAbandonment();
      });
      socket.once("close", (hadError) => {
        if (settled) return;
        if (peerCase === "reset" && resetRequested && !hadError) {
          observedPhase = "client-close";
          observedCase = peerCase;
          settled = true;
          pendingAbandonments.delete(refuseAbandonment);
          resolveAbandonment();
        } else refuseAbandonment(new Error("The native peer closed before admitted abandonment."));
      });
      socket.on("error", () =>
        refuseAbandonment(new Error("The native peer failed during abandonment.")),
      );
      socket.pause();
      const pad = (): void => {
        assertLive();
        if (
          peerCase !== "reset" ||
          padded ||
          resetRequested ||
          socket.destroyed ||
          peers.get(peerCase)?.socket !== socket ||
          !sockets.has(socket)
        )
          throw new Error("The native reset case cannot admit padding.");
        padded = true;
        // One bounded hostile upgrade suffix supplies real readable
        // backpressure. It is never interpreted as HTTP/application input.
        paddingCompletion = track(
          new Promise<void>((resolve) => {
            socket.write(Buffer.alloc(128 * 1024), (error) => {
              // Reset may cancel this exact native write. Its callback remains
              // owned/joined; an earlier failure cannot qualify backpressure.
              if (error && !resetRequested && !retired)
                refuseAbandonment(new Error("The native padding failed before reset."));
              resolve();
            });
          }),
        );
      };
      const begin = (): Promise<void> => {
        assertLive();
        if (
          peers.get(peerCase)?.socket !== socket ||
          !sockets.has(socket) ||
          socket.destroyed ||
          finSent ||
          resetRequested
        )
          throw new Error("The native peer cannot repeat abandonment.");
        waitingCase = peerCase;
        observedCase = peerCase;
        if (peerCase === "fin") {
          finSent = true;
          waitingFor = "first-response-data";
          observedPhase = "fin-sent";
          socket.end();
          socket.resume();
          return abandoned;
        }
        if (
          !padded ||
          socket.writableEnded ||
          !observations.some(
            (entry) => entry.type === "read-backpressured" && entry.peerCase === "reset",
          )
        )
          throw new Error("The native reset lacks a fresh backpressure witness.");
        resetRequested = true;
        observedPhase = "reset-requested";
        socket.resetAndDestroy();
        return track(
          Promise.all([abandoned, paddingCompletion]).then(() => {
            assertLive();
            const owner = child;
            if (!owner || exited || !owner.connected || peers.get(peerCase)?.socket !== socket)
              throw new Error("The native child retired before response release.");
            // Join the actual parent TCP close and padding callback before the
            // child writes. This is a one-use control, never a delay/retry loop.
            return new Promise<void>((resolve, reject) => {
              owner.send({ type: "release-response", peerCase: "reset" }, (error) => {
                if (error) reject(new Error("The native response release could not be sent."));
                else resolve();
              });
            });
          }),
        );
      };
      peers.set(peerCase, { socket, begin, pad });
      return socket;
    },
    padResetPeer(socket: Net.Socket): void {
      const peer = peers.get("reset");
      if (peer?.socket !== socket) throw new Error("The reset case does not own this peer.");
      peer.pad();
    },
    abandonPeer(socket: Net.Socket, peerCase: PeerCase): Promise<void> {
      const peer = peers.get(peerCase);
      if (peer?.socket !== socket) throw new Error("The native case does not own this peer.");
      return peer.begin();
    },
    requestHealthy(
      port: number,
    ): Promise<{ readonly status: number | undefined; readonly text: string }> {
      assertLive();
      waitingFor = "healthy-response";
      waitingCase = undefined;
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
  // Run the real failing-write peer first, without ever calling end() on it.
  const resetPeer = fixture.openUpgrade(port, "reset");
  await fixture.waitFor("route-entered", "reset");
  fixture.padResetPeer(resetPeer);
  const backpressure = await fixture.waitFor("read-backpressured", "reset");
  assert.isNumber(backpressure.highWaterMark);
  assert.isNumber(backpressure.bufferedBytes);
  assert.isTrue(backpressure.highWaterMark! > 0 && backpressure.highWaterMark! <= 64 * 1024);
  assert.isTrue(
    backpressure.bufferedBytes! >= backpressure.highWaterMark! &&
      backpressure.bufferedBytes! <= 128 * 1024,
  );
  await fixture.abandonPeer(resetPeer, "reset");
  const failure = await fixture.waitFor("native-error", "reset");
  assert.oneOf(failure.code, ["EPIPE", "ECONNRESET"]);
  assert.oneOf(failure.syscall, ["write", "writev"]);
  await fixture.waitFor("peer-closed", "reset");
  // Keep the original FIN request on a different peer. Its observations
  // cannot supply the independent reset peer's required native write error.
  const finPeer = fixture.openUpgrade(port, "fin");
  await fixture.waitFor("route-entered", "fin");
  await fixture.abandonPeer(finPeer, "fin");
  await fixture.waitFor("peer-ended", "fin");
  await fixture.waitFor("response-admitted", "fin");
  await fixture.waitFor("peer-closed", "fin");
  assert.deepEqual(await fixture.requestHealthy(port), { status: 200, text: "healthy" });
  assert.deepEqual(await fixture.close(), { code: 0, signal: null });
});
