import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import * as Socket from "effect/unstable/socket/Socket";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeUrl = import.meta.resolve("effect/unstable/rpc/RpcClient");
const runtimePath = fileURLToPath(runtimeUrl);
const runtimeSource = readFileSync(runtimePath, "utf8");
const routingMapLines = runtimeSource
  .split("\n")
  .flatMap((line, index) =>
    line.trim() === "const requestClientMap = new Map();" ? [index + 1] : [],
  );

class CapturedRoutingMap extends Map<string, number> {
  peakSize = 0;

  override set(key: string, value: number): this {
    super.set(key, value);
    this.peakSize = Math.max(this.peakSize, this.size);
    return this;
  }
}

interface SocketGeneration {
  readonly inbox: Queue.Queue<string, Socket.SocketError>;
  readonly sent: string[];
}

interface ProtocolFixture {
  readonly protocol: RpcClient.Protocol["Service"];
  readonly routingMap: CapturedRoutingMap;
  readonly generations: SocketGeneration[];
  readonly received: Array<{ readonly clientId: number; readonly message: FromServerEncoded }>;
}

function eventually(assertion: () => void): Effect.Effect<void> {
  return Effect.gen(function* () {
    let lastFailure: unknown;
    for (let turn = 0; turn < 100; turn += 1) {
      try {
        assertion();
        return;
      } catch (failure) {
        lastFailure = failure;
        yield* Effect.yieldNow;
      }
    }
    throw lastFailure;
  });
}

async function withProtocolFixture(
  run: (fixture: ProtocolFixture) => Effect.Effect<void, unknown>,
  options?: { readonly retry?: boolean },
): Promise<void> {
  const generations: SocketGeneration[] = [];
  const received: ProtocolFixture["received"] = [];
  const socket = Socket.make({
    // The actual Effect protocol owns its parser, pinger, routing map, error
    // broadcast and retry loop. Only network I/O is an inert controlled peer.
    runRaw: (handler, options) =>
      Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<string, Socket.SocketError>();
        generations.push({ inbox, sent: [] });
        yield* options?.onOpen ?? Effect.void;
        return yield* Queue.take(inbox).pipe(
          Effect.flatMap((message) => {
            const result = handler(message);
            return Effect.isEffect(result) ? result : Effect.void;
          }),
          Effect.forever,
        );
      }),
    writer: Effect.succeed((chunk) =>
      Effect.sync(() => {
        const current = generations.at(-1);
        if (!current) throw new Error("The controlled socket has not opened.");
        current.sent.push(typeof chunk === "string" ? chunk : String(chunk));
      }),
    ),
  });
  const nativeMap = globalThis.Map;
  let routingMap: CapturedRoutingMap | undefined;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        expect(routingMapLines).toHaveLength(1);
        const sourceLine = routingMapLines[0];
        // Instrument only this exact private Map allocation, never every Map
        // or process heap totals. The pinned installed source identifies its
        // allocation frame; the real instance's retained entry count is the
        // assertion. Restore the constructor immediately after capture and
        // again in finally, including setup failures. No production debug API,
        // request payload logging, ambient socket or provider is introduced.
        globalThis.Map = new Proxy(nativeMap, {
          construct(target, argumentsList, newTarget) {
            const stack = new Error().stack ?? "";
            if (
              stack.includes(`${runtimeUrl}:${sourceLine}:`) ||
              stack.includes(`${runtimePath}:${sourceLine}:`)
            ) {
              if (routingMap) throw new Error("Unexpected second protocol routing map.");
              routingMap = new CapturedRoutingMap();
              globalThis.Map = nativeMap;
              return routingMap;
            }
            return Reflect.construct(target, argumentsList, newTarget);
          },
        });
        const protocol = yield* RpcClient.makeProtocolSocket({
          retryPolicy: options?.retry === false ? Schedule.recurs(0) : Schedule.forever,
          retryTransientErrors: false,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.Map = nativeMap;
            }),
          ),
        );
        if (!routingMap) throw new Error("The installed protocol routing map was not captured.");
        for (const clientId of [1, 2]) {
          yield* protocol
            .run(clientId, (message) =>
              Effect.sync(() => {
                received.push({ clientId, message });
              }),
            )
            .pipe(Effect.forkScoped);
        }
        yield* eventually(() => expect(generations).toHaveLength(1));
        yield* run({ protocol, routingMap, generations, received });
      }),
    ).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerJson),
    ),
  ).finally(() => {
    globalThis.Map = nativeMap;
  });
  // Session disposal must retire even requests that never received an Exit.
  expect(routingMap?.size).toBe(0);
}

function request(id: string, stream: boolean) {
  return {
    _tag: "Request" as const,
    id,
    tag: stream ? "fixture.stream" : "fixture.unary",
    payload: {},
    headers: [],
  };
}

describe("pinned Effect socket RPC compatibility", () => {
  it("bounds the actual routing map over 16,384 requests across 64 failed socket generations", async () => {
    await withProtocolFixture(({ protocol, routingMap, generations, received }) =>
      Effect.gen(function* () {
        const batchSize = 256;
        for (let cycle = 0; cycle < 64; cycle += 1) {
          for (let index = 0; index < batchSize; index += 1) {
            yield* protocol.send(1 + (index % 2), request(`${cycle}:${index}`, index % 2 === 0));
          }
          expect(routingMap.size).toBe(batchSize);
          yield* Queue.fail(
            generations[cycle]!.inbox,
            new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1012 }) }),
          );
          yield* eventually(() => expect(generations).toHaveLength(cycle + 2));
          expect(routingMap.size).toBe(0);
          const failureBroadcasts = received.filter(
            ({ message }) => message._tag === "ClientProtocolError",
          );
          expect(failureBroadcasts).toHaveLength((cycle + 1) * 2);
          // Unknown request-bound frames from a failed generation must not be
          // broadcast to either unrelated client on the replacement socket.
          yield* Queue.offer(
            generations[cycle + 1]!.inbox,
            JSON.stringify({ _tag: "Chunk", requestId: `${cycle}:0`, values: ["stale"] }),
          );
          yield* Effect.yieldNow;
          expect(received.some(({ message }) => message._tag === "Chunk")).toBe(false);
        }
        expect(routingMap.peakSize).toBe(batchSize);
        yield* protocol.send(2, request("fresh", false));
        yield* Queue.offer(
          generations.at(-1)!.inbox,
          JSON.stringify({
            _tag: "Exit",
            requestId: "fresh",
            exit: { _tag: "Success", value: "current" },
          }),
        );
        yield* eventually(() => expect(routingMap.size).toBe(0));
        expect(received.filter(({ message }) => message._tag === "Exit")).toEqual([
          {
            clientId: 2,
            message: {
              _tag: "Exit",
              requestId: "fresh",
              exit: { _tag: "Success", value: "current" },
            },
          },
        ]);
        // A request left outstanding on an otherwise healthy peer is retired
        // by the scope finalizer asserted outside the running fixture above.
        yield* protocol.send(1, request("dispose-without-exit", true));
      }),
    );
  });

  it("retires only the interrupted request and keeps unrelated client routing intact", async () => {
    await withProtocolFixture(({ protocol, routingMap }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 4_096; index += 1) {
          const id = `interrupt:${index}`;
          yield* protocol.send(1, request(id, index % 2 === 0));
          expect(routingMap.size).toBe(1);
          yield* protocol.send(2, { _tag: "Interrupt", requestId: id });
          expect(routingMap.get(id)).toBe(1);
          yield* protocol.send(1, { _tag: "Interrupt", requestId: id });
          expect(routingMap.size).toBe(0);
        }
        expect(routingMap.peakSize).toBe(1);
      }),
    );
  });

  it("retires a request route when the real JSON encoder throws before writing", async () => {
    await withProtocolFixture(({ protocol, routingMap, generations }) =>
      Effect.gen(function* () {
        const circularPayload: { self?: unknown } = {};
        circularPayload.self = circularPayload;
        const result = yield* Effect.exit(
          Effect.suspend(() =>
            protocol.send(1, { ...request("encoder-failure", false), payload: circularPayload }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(routingMap.size).toBe(0);
        expect(generations[0]!.sent).toHaveLength(0);
      }),
    );
  });

  it("rejects a lazy send evaluated after its socket generation has failed", async () => {
    await withProtocolFixture(
      ({ protocol, routingMap, generations, received }) =>
        Effect.gen(function* () {
          // Building an Effect does not acquire ownership or authorize a later
          // write. Admission must observe the generation at evaluation time.
          const deferredSend = protocol.send(1, request("late-evaluation", false));
          yield* Queue.fail(
            generations[0]!.inbox,
            new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1012 }) }),
          );
          yield* eventually(() => expect(received).toHaveLength(2));
          const result = yield* Effect.exit(deferredSend);
          expect(result._tag).toBe("Failure");
          expect(routingMap.size).toBe(0);
          expect(generations[0]!.sent).toHaveLength(0);
          expect(generations).toHaveLength(1);
        }),
      { retry: false },
    );
  });

  it.each(["malformed-json", "remote-defect"])(
    "retires requests when a live protocol broadcasts a failure: %s",
    async (failureKind) => {
      await withProtocolFixture(({ protocol, routingMap, generations, received }) =>
        Effect.gen(function* () {
          for (let index = 0; index < 128; index += 1) {
            yield* protocol.send(1 + (index % 2), request(`decode:${index}`, index % 2 === 0));
          }
          yield* Queue.offer(
            generations[0]!.inbox,
            failureKind === "malformed-json"
              ? "{"
              : JSON.stringify({ _tag: "Defect", defect: "controlled peer failure" }),
          );
          yield* eventually(() => expect(received).toHaveLength(2));
          expect(routingMap.size).toBe(0);
          expect(generations).toHaveLength(1);
        }),
      );
    },
  );
});
