import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString);

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            emittedAtMs: 1_721_234_567_890,
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            emittedAtMs: 1_721_234_567_890,
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("keeps draining inbound messages while an onRequest handler is waiting", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Effect.never,
      });

      const notificationDeferred =
        yield* Deferred.make<CodexProtocol.CodexAppServerIncomingNotification>();
      yield* transport.incomingNotifications.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.flatMap((notifications) =>
          Deferred.succeed(notificationDeferred, Array.from(notifications)[0]!),
        ),
        Effect.forkScoped,
      );

      const pendingInitialize = yield* transport.request("initialize").pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "initialize",
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 77,
          method: "item/tool/requestUserInput",
          params: {
            itemId: "item-approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [],
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/after-blocked-request",
          params: {
            ok: true,
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          result: {
            userAgent: "mock-codex-app-server",
          },
        }),
      );

      assert.deepEqual(yield* Deferred.await(notificationDeferred), {
        method: "x/after-blocked-request",
        params: {
          ok: true,
        },
      });
      assert.deepEqual(yield* Fiber.join(pendingInitialize), {
        userAgent: "mock-codex-app-server",
      });
    }),
  );

  it.effect("keeps draining inbound messages while an onNotification handler is waiting", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: () => Effect.never,
      });

      const pendingInitialize = yield* transport.request("initialize").pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "initialize",
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/blocked-notification",
          params: {
            ok: true,
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          result: {
            userAgent: "mock-codex-app-server",
          },
        }),
      );

      const result = yield* Fiber.join(pendingInitialize).pipe(Effect.timeoutOption("1 second"));
      assert.equal(Option.isSome(result), true);
      if (Option.isSome(result)) {
        assert.deepEqual(result.value, {
          userAgent: "mock-codex-app-server",
        });
      }
    }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode Codex App Server message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode Codex App Server message");
    }),
  );

  it.effect("keeps reading notifications after onNotification defects", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const protocolEvents = yield* Ref.make<Array<CodexProtocol.CodexAppServerProtocolLogEvent>>(
        [],
      );
      const goodNotification =
        yield* Deferred.make<CodexProtocol.CodexAppServerIncomingNotification>();
      const badDiagnosticLogged = yield* Deferred.make<void>();

      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        logger: (event) =>
          Ref.update(protocolEvents, (current) => [...current, event]).pipe(
            Effect.andThen(() => {
              const payload =
                typeof event.payload === "object" && event.payload !== null
                  ? (event.payload as Record<string, unknown>)
                  : {};
              return event.stage === "decode_failed" && payload["method"] === "x/bad"
                ? Deferred.succeed(badDiagnosticLogged, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
        onNotification: (notification) =>
          notification.method === "x/bad"
            ? Effect.die(new Error("defective notification callback"))
            : Deferred.succeed(goodNotification, notification).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/bad",
          params: {
            secret: "must-not-be-logged",
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/good",
          params: {
            ok: true,
          },
        }),
      );

      assert.deepEqual(yield* Deferred.await(goodNotification), {
        method: "x/good",
        params: {
          ok: true,
        },
      });
      yield* Deferred.await(badDiagnosticLogged);

      const diagnostics = (yield* Ref.get(protocolEvents)).filter(
        (event) => event.stage === "decode_failed",
      );
      assert.equal(diagnostics.length, 1);
      const diagnosticPayload = diagnostics[0]?.payload as Record<string, unknown>;
      assert.equal(diagnosticPayload["method"], "x/bad");
      assert.equal(String(diagnosticPayload["cause"]).includes("must-not-be-logged"), false);
    }),
  );
});
