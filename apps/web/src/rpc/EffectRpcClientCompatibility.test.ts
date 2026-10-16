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
import { describe, expect, it } from "vitest";
const streamRpc = Rpc.make("stream", {
  payload: Schema.Struct({}),
  success: Schema.String,
  stream: true,
});
const group = RpcGroup.make(
  Rpc.make("unary", { payload: Schema.Struct({}), success: Schema.String }),
  streamRpc,
);
const makeClient = RpcClient.make(group, { disableTracing: true });
type Client = Effect.Success<typeof makeClient>;
interface SocketGeneration {
  readonly inbox: Queue.Queue<string, Socket.SocketError>;
  readonly sent: string[];
}
interface ClientFixture {
  readonly clients: readonly [Client, Client];
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
    // The peer delivers stale frames before these valid replies. Exact final
    // results prove neither client accepted them without counting event-loop turns.
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
async function withClientFixture(
  run: (fixture: ClientFixture) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> {
  const generations: SocketGeneration[] = [];
  const socket = Socket.make({
    // The installed protocol performs framing, routing, heartbeat, retry and
    // broadcasts. Only the network peer is controlled and credential-free.
    runRaw: (handler, socketOptions) =>
      Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<string, Socket.SocketError>();
        generations.push({ inbox, sent: [] });
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
      }),
    ),
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const protocol = yield* RpcClient.makeProtocolSocket({
          retryPolicy: Schedule.forever,
          retryTransientErrors: false,
        });
        const first = yield* makeClient.pipe(Effect.provideService(RpcClient.Protocol, protocol));
        const second = yield* makeClient.pipe(Effect.provideService(RpcClient.Protocol, protocol));
        yield* eventually(() => expect(generations).toHaveLength(1));
        yield* run({ clients: [first, second], generations });
      }),
    ).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerJson),
      Effect.provide(TestClock.layer()),
    ),
  );
}
describe("typed RPC feature behavior", () => {
  it("routes unary replies to the correct client", async () => {
    await withClientFixture(({ clients, generations }) =>
      Effect.gen(function* () {
        yield* verifyFreshClients(clients, generations[0]!, "retired-id");
      }),
    );
  });
  it("fails disconnected pending work and accepts fresh replies without replay", async () => {
    await withClientFixture(({ clients, generations }) =>
      Effect.gen(function* () {
        for (let cycle = 0; cycle < 2; cycle++) {
          const current = generations[cycle]!;
          const countBefore = requests(current).length;
          const pending = yield* clients[0].unary({}).pipe(Effect.exit, Effect.forkScoped);
          yield* eventually(() => expect(requests(current)).toHaveLength(countBefore + 1));
          const retired = requests(current)[countBefore]!.id;
          yield* Queue.fail(
            current.inbox,
            new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1012 }) }),
          );
          expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
          yield* eventually(() => expect(generations).toHaveLength(cycle + 2));
          yield* verifyFreshClients(clients, generations[cycle + 1]!, retired);
        }
      }),
    );
  });
  it("keeps the other client usable after cancellation", async () => {
    await withClientFixture(({ clients, generations }) =>
      Effect.gen(function* () {
        const pending = yield* Stream.runDrain(clients[0].stream({})).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* eventually(() => expect(requests(generations[0]!)).toHaveLength(1));
        const retired = requests(generations[0]!)[0]!.id;
        yield* Fiber.interrupt(pending);
        yield* verifyFreshClients(clients, generations[0]!, retired);
      }),
    );
  });
  it("delivers stream chunks and completion through the declared schema", async () => {
    await withClientFixture(({ clients, generations }) =>
      Effect.gen(function* () {
        const pending = yield* Stream.runCollect(clients[0].stream({})).pipe(Effect.forkScoped);
        yield* eventually(() => expect(requests(generations[0]!)).toHaveLength(1));
        const id = requests(generations[0]!)[0]!.id;
        yield* Queue.offer(
          generations[0]!.inbox,
          JSON.stringify({ _tag: "Chunk", requestId: id, values: ["first", "second"] }),
        );
        yield* Queue.offer(
          generations[0]!.inbox,
          JSON.stringify({
            _tag: "Exit",
            requestId: id,
            exit: Schema.encodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(streamRpc)))(
              Exit.void,
            ),
          }),
        );
        expect(yield* Fiber.join(pending)).toEqual(["first", "second"]);
      }),
    );
  });
});
