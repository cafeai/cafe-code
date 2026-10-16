import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeUrl = import.meta.resolve("effect/unstable/rpc/RpcClient");
const runtimePath = fileURLToPath(runtimeUrl);
const runtimeLines = readFileSync(runtimePath, "utf8").split("\n");

type RegistryKind = "routing" | "serialized" | "pending";

// Identify the exact pinned allocations, not arbitrary Maps or process heap
// growth. The worker protocol has another `entries` Map; it is deliberately
// excluded by the enclosing exported constructor rather than a loose match.
function registryAllocationLines(): Map<number, RegistryKind> {
  let constructor: RegistryKind | undefined;
  const lines = new Map<number, RegistryKind>();
  runtimeLines.forEach((line, index) => {
    if (line.startsWith("export const makeNoSerialization =")) constructor = "pending";
    else if (line.startsWith("export const make =")) constructor = "serialized";
    else if (line.startsWith("export const makeProtocolSocket =")) constructor = "routing";
    else if (line.startsWith("export const ")) constructor = undefined;
    if (
      constructor &&
      (line.trim() === "const entries = new Map();" ||
        line.trim() === "const requestClientMap = new Map();")
    ) {
      lines.set(index + 1, constructor);
    }
  });
  return lines;
}

class CapturedRegistry extends Map<unknown, unknown> {
  peakSize = 0;

  constructor(readonly kind: RegistryKind) {
    super();
  }

  override set(key: unknown, value: unknown): this {
    super.set(key, value);
    this.peakSize = Math.max(this.peakSize, this.size);
    return this;
  }
}

const group = RpcGroup.make(
  Rpc.make("unary", { payload: Schema.Struct({}), success: Schema.String }),
  Rpc.make("stream", { payload: Schema.Struct({}), success: Schema.String, stream: true }),
);
const makeClient = RpcClient.make(group, { disableTracing: true });
type Client = Effect.Success<typeof makeClient>;

interface SocketGeneration {
  readonly inbox: Queue.Queue<string, Socket.SocketError>;
  readonly sent: string[];
}

interface ClientFixture {
  readonly clients: readonly [Client, Client];
  readonly registries: CapturedRegistry[];
  readonly generations: SocketGeneration[];
}

function eventually(assertion: () => void): Effect.Effect<void> {
  return Effect.gen(function* () {
    let lastFailure: unknown;
    for (let turn = 0; turn < 200; turn += 1) {
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

function expectEmpty(registries: readonly CapturedRegistry[]): void {
  expect(registries.map(({ kind, size }) => ({ kind, size }))).toEqual([
    { kind: "routing", size: 0 },
    { kind: "serialized", size: 0 },
    { kind: "pending", size: 0 },
    { kind: "serialized", size: 0 },
    { kind: "pending", size: 0 },
  ]);
}

async function withClientFixture(
  run: (fixture: ClientFixture) => Effect.Effect<void, unknown, Scope.Scope>,
  options?: { readonly failBeforeClients?: boolean; readonly failWrites?: boolean },
): Promise<void> {
  const generations: SocketGeneration[] = [];
  const registries: CapturedRegistry[] = [];
  const socket = Socket.make({
    // The installed protocol performs framing, routing, heartbeat, retry and
    // broadcasts. Only the network peer is controlled and credential-free.
    runRaw: (handler, socketOptions) =>
      Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<string, Socket.SocketError>();
        generations.push({ inbox, sent: [] });
        if (options?.failBeforeClients) {
          return yield* Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({
                kind: "Unknown",
                cause: "controlled acquisition failure",
              }),
            }),
          );
        }
        yield* socketOptions?.onOpen ?? Effect.void;
        return yield* Queue.take(inbox).pipe(
          Effect.flatMap((message) => {
            const handled = handler(message);
            return Effect.isEffect(handled) ? handled : Effect.void;
          }),
          Effect.forever,
        );
      }),
    writer: Effect.succeed((chunk) =>
      Effect.gen(function* () {
        const current = generations.at(-1);
        if (!current) throw new Error("The controlled socket has not opened.");
        current.sent.push(typeof chunk === "string" ? chunk : String(chunk));
        if (options?.failWrites) {
          return yield* Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketWriteError({ cause: "controlled writer failure" }),
            }),
          );
        }
      }),
    ),
  });
  const nativeMap = globalThis.Map;
  const allocations = registryAllocationLines();
  expect([...allocations.values()]).toEqual(["pending", "serialized", "routing"]);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // A constructor proxy captures only the five private registries of
          // this protocol and its two real typed clients. Restore immediately
          // after the fifth allocation, with an unconditional failure cleanup.
          globalThis.Map = new Proxy(nativeMap, {
            construct(target, argumentsList, newTarget) {
              const stack = new Error().stack ?? "";
              for (const [line, kind] of allocations) {
                if (
                  stack.includes(`${runtimeUrl}:${line}:`) ||
                  stack.includes(`${runtimePath}:${line}:`)
                ) {
                  const registry = new CapturedRegistry(kind);
                  registries.push(registry);
                  if (registries.length === 5) globalThis.Map = nativeMap;
                  return registry;
                }
              }
              return Reflect.construct(target, argumentsList, newTarget);
            },
          });
          const protocol = yield* RpcClient.makeProtocolSocket({
            retryPolicy: options?.failBeforeClients ? Schedule.recurs(0) : Schedule.forever,
            retryTransientErrors: false,
          });
          if (options?.failBeforeClients) {
            // Fail acquisition before either client registers its message
            // consumer. Its later Request fails directly from send instead of
            // an already-observed broadcast; that path must retire both maps.
            for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
          }
          const first = yield* makeClient.pipe(Effect.provideService(RpcClient.Protocol, protocol));
          const second = yield* makeClient.pipe(
            Effect.provideService(RpcClient.Protocol, protocol),
          );
          globalThis.Map = nativeMap;
          expect(registries).toHaveLength(5);
          yield* eventually(() => expect(generations).toHaveLength(1));
          yield* run({ clients: [first, second], registries, generations });
        }),
      ).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
        Effect.provide(TestClock.layer()),
      ),
    );
    // Scope disposal independently retires requests that never receive Exit.
    expectEmpty(registries);
  } finally {
    globalThis.Map = nativeMap;
  }
}

function startRequests(clients: ClientFixture["clients"], count: number) {
  return Effect.gen(function* () {
    const fibers: Array<Fiber.Fiber<Exit.Exit<unknown, unknown>>> = [];
    for (let index = 0; index < count; index += 1) {
      const client = clients[index % 2]!;
      const request = index % 4 < 2 ? client.unary({}) : Stream.runDrain(client.stream({}));
      fibers.push(yield* request.pipe(Effect.exit, Effect.forkScoped));
    }
    return fibers;
  });
}

function requests(generation: SocketGeneration) {
  return generation.sent.flatMap((encoded) => {
    const message = JSON.parse(encoded) as { _tag: string; id: string; tag: string };
    return message._tag === "Request" ? [message] : [];
  });
}

function verifyFreshClients(
  clients: ClientFixture["clients"],
  generation: SocketGeneration,
  retiredId: string,
) {
  return Effect.gen(function* () {
    const countBefore = requests(generation).length;
    const first = yield* clients[0].unary({}).pipe(Effect.exit, Effect.forkScoped);
    const second = yield* clients[1].unary({}).pipe(Effect.exit, Effect.forkScoped);
    yield* eventually(() => expect(requests(generation)).toHaveLength(countBefore + 2));
    const freshRequests = requests(generation).slice(countBefore);
    yield* Queue.offer(
      generation.inbox,
      JSON.stringify({
        _tag: "Exit",
        requestId: retiredId,
        exit: { _tag: "Success", value: "stale" },
      }),
    );
    yield* Queue.offer(
      generation.inbox,
      JSON.stringify({ _tag: "Chunk", requestId: retiredId, values: ["stale"] }),
    );
    // Neither client may accept retired routing even with active fresh work.
    for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
    expect(first.pollUnsafe()).toBeUndefined();
    expect(second.pollUnsafe()).toBeUndefined();
    for (const [index, request] of freshRequests.entries()) {
      yield* Queue.offer(
        generation.inbox,
        JSON.stringify({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value: `client-${index}` },
        }),
      );
    }
    expect(yield* Fiber.join(first)).toEqual(Exit.succeed("client-0"));
    expect(yield* Fiber.join(second)).toEqual(Exit.succeed("client-1"));
  });
}

describe("pinned Effect typed RPC registry compatibility", () => {
  it("bounds all five actual registries across 4,096 typed unary/stream requests and 64 socket drops", async () => {
    await withClientFixture(({ clients, registries, generations }) =>
      Effect.gen(function* () {
        const batchSize = 64;
        for (let cycle = 0; cycle < 64; cycle += 1) {
          const countBefore = requests(generations[cycle]!).length;
          const fibers = yield* startRequests(clients, batchSize);
          yield* eventually(() =>
            expect(requests(generations[cycle]!)).toHaveLength(countBefore + batchSize),
          );
          expect(registries.map(({ size }) => size)).toEqual([64, 32, 32, 32, 32]);
          const retiredId = requests(generations[cycle]!)[countBefore]!.id;
          yield* Queue.fail(
            generations[cycle]!.inbox,
            new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1012 }) }),
          );
          yield* eventually(() => expect(generations).toHaveLength(cycle + 2));
          for (const fiber of fibers) expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          expectEmpty(registries);
          yield* verifyFreshClients(clients, generations[cycle + 1]!, retiredId);
          expectEmpty(registries);
        }
        expect(registries.map(({ peakSize }) => peakSize)).toEqual([64, 32, 32, 32, 32]);
      }),
    );
  });

  it.each(["malformed-json", "remote-defect", "client-protocol-error"])(
    "retires every actual client registry after a live failure broadcast: %s",
    async (kind) => {
      await withClientFixture(({ clients, registries, generations }) =>
        Effect.gen(function* () {
          for (let cycle = 0; cycle < 16; cycle += 1) {
            const countBefore = requests(generations[0]!).length;
            const fibers = yield* startRequests(clients, 32);
            yield* eventually(() =>
              expect(requests(generations[0]!)).toHaveLength(countBefore + 32),
            );
            const retiredId = requests(generations[0]!)[countBefore]!.id;
            const message =
              kind === "malformed-json"
                ? "{"
                : JSON.stringify(
                    kind === "remote-defect"
                      ? { _tag: "Defect", defect: "controlled peer failure" }
                      : {
                          _tag: "ClientProtocolError",
                          error: {
                            _tag: "RpcClientError",
                            reason: { _tag: "RpcClientDefect", message: "controlled peer failure" },
                          },
                        },
                  );
            yield* Queue.offer(generations[0]!.inbox, message);
            for (const fiber of fibers) expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
            expectEmpty(registries);
            expect(generations).toHaveLength(1);
            yield* verifyFreshClients(clients, generations[0]!, retiredId);
            expectEmpty(registries);
          }
          expect(registries.map(({ peakSize }) => peakSize)).toEqual([32, 16, 16, 16, 16]);
        }),
      );
    },
  );

  it("retires all actual registries across 2,048 interrupted unary/stream requests", async () => {
    await withClientFixture(({ clients, registries, generations }) =>
      Effect.gen(function* () {
        for (let cycle = 0; cycle < 64; cycle += 1) {
          const countBefore = requests(generations[0]!).length;
          const fibers = yield* startRequests(clients, 32);
          yield* eventually(() => expect(requests(generations[0]!)).toHaveLength(countBefore + 32));
          for (const fiber of fibers) yield* Fiber.interrupt(fiber);
          expectEmpty(registries);
        }
        expect(registries.map(({ peakSize }) => peakSize)).toEqual([32, 16, 16, 16, 16]);
      }),
    );
  });

  it("retires unary/stream send failures after acquisition fails before client registration", async () => {
    await withClientFixture(
      ({ clients, registries }) =>
        Effect.gen(function* () {
          for (let cycle = 0; cycle < 64; cycle += 1) {
            const fibers = yield* startRequests(clients, 16);
            for (const fiber of fibers) expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
            expectEmpty(registries);
          }
          // The failure is immediate and serializable; no routes reach the wire
          // and every failed direct send retires its schema/context and waiter.
          expect(registries[0]!.peakSize).toBe(0);
          for (const registry of registries.slice(1))
            expect(registry.peakSize).toBeLessThanOrEqual(8);
        }),
      { failBeforeClients: true },
    );
  });

  it("bounds every registry across 32 actual Ping/Pong and missing-Pong recovery cycles", async () => {
    await withClientFixture(({ clients, registries, generations }) =>
      Effect.gen(function* () {
        for (let cycle = 0; cycle < 32; cycle += 1) {
          const generation = generations[cycle]!;
          const countBefore = requests(generation).length;
          const fibers = yield* startRequests(clients, 32);
          yield* eventually(() => expect(requests(generation)).toHaveLength(countBefore + 32));
          yield* TestClock.adjust("5 seconds");
          yield* eventually(() =>
            expect(generation.sent.some((encoded) => JSON.parse(encoded)._tag === "Ping")).toBe(
              true,
            ),
          );
          yield* Queue.offer(generation.inbox, JSON.stringify({ _tag: "Pong" }));
          for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          expect(generations).toHaveLength(cycle + 1);
          // The second Ping is intentionally unanswered. Drive the actual
          // pinned pinger, never its callback or a private recovery method.
          yield* TestClock.adjust("5 seconds");
          yield* eventually(() => expect(generations).toHaveLength(cycle + 2));
          for (const fiber of fibers) expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          expectEmpty(registries);
        }
        expect(registries.map(({ peakSize }) => peakSize)).toEqual([32, 16, 16, 16, 16]);
      }),
    );
  });

  it("retires all actual registries across 1,024 Request writes rejected by the controlled socket", async () => {
    await withClientFixture(
      ({ clients, registries, generations }) =>
        Effect.gen(function* () {
          for (let cycle = 0; cycle < 64; cycle += 1) {
            const fibers = yield* startRequests(clients, 16);
            for (const fiber of fibers) expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
            expectEmpty(registries);
          }
          expect(requests(generations[0]!)).toHaveLength(1_024);
          // This direct Request write failure does not require a generation
          // failure broadcast to clear schema/context, callback or routing.
          expect(generations).toHaveLength(1);
          expect(registries[0]!.peakSize).toBeLessThanOrEqual(16);
          for (const registry of registries.slice(1))
            expect(registry.peakSize).toBeLessThanOrEqual(8);
        }),
      { failWrites: true },
    );
  });

  it("retires every registry when an actual stream chunk violates the declared schema", async () => {
    for (let cycle = 0; cycle < 16; cycle += 1) {
      await withClientFixture(({ clients, registries, generations }) =>
        Effect.gen(function* () {
          const generation = generations[0]!;
          const fibers = yield* startRequests(clients, 32);
          yield* eventually(() => expect(requests(generation)).toHaveLength(32));
          const streamRequest = requests(generation).find(({ tag }) => tag === "stream");
          expect(streamRequest).toBeDefined();
          yield* Queue.offer(
            generation.inbox,
            JSON.stringify({ _tag: "Chunk", requestId: streamRequest!.id, values: [42] }),
          );
          for (const fiber of fibers) expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          expectEmpty(registries);
          // The pinned codec reports a defect, not a typed transport failure;
          // do not broaden retry/replay authority just to assert reclamation.
          expect(registries.map(({ peakSize }) => peakSize)).toEqual([32, 16, 16, 16, 16]);
        }),
      );
    }
  });

  it("clears scope-owned registries even for discarded requests with no pending caller", async () => {
    await withClientFixture(({ clients, registries, generations }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 64; index += 1) {
          yield* clients[index % 2]!.unary({}, { discard: true });
        }
        yield* eventually(() => expect(requests(generations[0]!)).toHaveLength(64));
        // No waiter exists to send an Interrupt. Session scope finalizers must
        // independently clear routing and retained serialized schema/context.
        expect(registries.map(({ size }) => size)).toEqual([64, 32, 0, 32, 0]);
      }),
    );
  });
});
