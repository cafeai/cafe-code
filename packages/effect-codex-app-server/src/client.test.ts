import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import * as Ref from "effect/Ref";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const encoder = new TextEncoder();
const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const command = ChildProcess.make(process.execPath, [yield* mockPeerPath], {
        cwd: path.join(import.meta.dirname, ".."),
        shell: false,
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", () =>
          Effect.fail(CodexError.CodexAppServerRequestError.internalError("test handler failed")),
        );
        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const skills = yield* client.request("skills/list", {
          cwds: [process.cwd()],
        });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, process.cwd());

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );

  it.effect("initializes a command-backed app-server client", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerCommand({
        command: process.execPath,
        args: [yield* mockPeerPath],
        cwd: path.join(import.meta.dirname, ".."),
      });
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );

  it.effect("keeps dispatching notifications after a handler defect", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const protocolEvents = yield* Ref.make<Array<CodexProtocol.CodexAppServerProtocolLogEvent>>(
        [],
      );
      const received = yield* Ref.make<Array<unknown>>([]);
      const receivedBoth = yield* Deferred.make<ReadonlyArray<unknown>>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* CodexClient.make(stdio, {
            logger: (event) => Ref.update(protocolEvents, (current) => [...current, event]),
          });

          yield* client.handleServerNotification("item/agentMessage/delta", () =>
            Effect.die(new Error("defective notification handler")),
          );
          yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
            Ref.update(received, (current) => [...current, payload]).pipe(
              Effect.flatMap(() => Ref.get(received)),
              Effect.tap((current) =>
                current.length >= 2 ? Deferred.succeed(receivedBoth, current) : Effect.void,
              ),
              Effect.asVoid,
            ),
          );

          yield* Queue.offer(
            input,
            encodeJsonl({
              method: "item/agentMessage/delta",
              params: {
                delta: "first",
                itemId: "item-1",
                threadId: "thread-1",
                turnId: "turn-1",
              },
            }),
          );
          yield* Queue.offer(
            input,
            encodeJsonl({
              method: "item/agentMessage/delta",
              params: {
                delta: "second",
                itemId: "item-2",
                threadId: "thread-1",
                turnId: "turn-1",
              },
            }),
          );

          assert.deepEqual(yield* Deferred.await(receivedBoth), [
            {
              delta: "first",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
            {
              delta: "second",
              itemId: "item-2",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          ]);
        }),
      );

      const diagnosticEvents = (yield* Ref.get(protocolEvents)).filter(
        (event) => event.stage === "decode_failed",
      );
      assert.equal(diagnosticEvents.length, 2);
      assert.deepEqual(
        diagnosticEvents.map((event) =>
          typeof event.payload === "object" && event.payload !== null
            ? (event.payload as Record<string, unknown>)["method"]
            : undefined,
        ),
        ["item/agentMessage/delta", "item/agentMessage/delta"],
      );
    }),
  );
});
