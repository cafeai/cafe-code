// @effect-diagnostics nodeBuiltinImport:off
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovalRequestId,
  GeminiSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type UsageAccountingSnapshot,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { fileAttachmentStoragePaths, storeFileAttachment } from "../../fileAttachmentStore.ts";
import * as ManagementMcp from "../../mcp/sessionConnection.ts";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-gemini-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const fixtureFile = fileURLToPath(new URL("../testUtils/geminiAcpFixture.cjs", import.meta.url));
const decodeJsonText = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

const makeFixtureAdapter = Effect.fnUntraced(function* (environment: NodeJS.ProcessEnv = {}) {
  const config = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Exercise the real stdio transport even on Windows, without relying on
  // shell launchers or adding a test-only adapter injection.
  const fixtureSpawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
      return spawner.spawn(command);
    }
    return spawner.spawn(
      ChildProcess.make(process.execPath, [fixtureFile, ...command.args], {
        ...command.options,
        env: {
          ...command.options.env,
          ...environment,
          CAFE_GEMINI_FIXTURE_NATIVE_VERSION: "1.5.16",
        },
      }),
    );
  });
  const instanceId = ProviderInstanceId.make("gemini-fixture");
  const threadId = ThreadId.make("gemini-thread");
  const modelSelection = {
    instanceId,
    model: "gemini-4-neon",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const adapter = yield* makeGeminiAdapter(
    Schema.decodeUnknownSync(GeminiSettings)({ enabled: true, binaryPath: process.execPath }),
    { instanceId },
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner));
  return {
    adapter,
    instanceId,
    modelSelection,
    threadId,
    start: { threadId, cwd: config.cwd, runtimeMode: "full-access", modelSelection } as const,
  };
});

it.live(
  "mounts a distinct Cafe MCP bridge on Gemini open and resume and retires both bindings",
  () =>
    Effect.gen(function* () {
      const retired: string[] = [];
      let nextBinding = 1;
      const bind = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(ManagementMcp, "makeManagementMcpSession").mockImplementation(() => {
            const generation = nextBinding++;
            const name = `cafe-code-fixture-${generation}`;
            return Effect.succeed({
              name,
              launch: {
                command: process.execPath,
                args: [`fixture-bridge-${generation}`, `fixture-connection-${generation}`],
                env: { ELECTRON_RUN_AS_NODE: "1" },
              },
              dispose: Effect.sync(() => {
                retired.push(name);
              }),
            });
          }),
        ),
        (spy) => Effect.sync(() => void spy.mockRestore()),
      );
      const { adapter, threadId, instanceId, start } = yield* makeFixtureAdapter({
        CAFE_GEMINI_FIXTURE_EXPECT_MANAGEMENT_MCP: "true",
      });
      const opened = yield* adapter.startSession(start);
      assert.isDefined(opened.resumeCursor);
      assert.deepEqual(retired, []);
      yield* adapter.stopSession(threadId);
      assert.deepEqual(retired, ["cafe-code-fixture-1"]);

      yield* adapter.startSession({ ...start, resumeCursor: opened.resumeCursor });
      assert.deepEqual(bind.mock.calls, [
        [{ threadId, providerInstanceId: instanceId }],
        [{ threadId, providerInstanceId: instanceId }],
      ]);
      assert.deepEqual(retired, ["cafe-code-fixture-1"]);
      yield* adapter.stopSession(threadId);
      assert.deepEqual(retired, ["cafe-code-fixture-1", "cafe-code-fixture-2"]);
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "delivers a qualified Gemini prompt, permits only its one-time approval, and stops the resumed owner",
  () =>
    Effect.gen(function* () {
      const { adapter, threadId, instanceId, modelSelection, start } = yield* makeFixtureAdapter();

      const approval = yield* Deferred.make<ApprovalRequestId>();
      const completed = yield* Deferred.make<void>();
      const resumedText = yield* Deferred.make<void>();
      const deltas: string[] = [];
      const usage: number[] = [];
      const accounting: UsageAccountingSnapshot[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          assert.equal(event.threadId, threadId);
          assert.equal(event.providerInstanceId, instanceId);
          if (event.type === "request.opened") {
            assert.equal(event.payload.detail, "ls");
            if (!event.requestId) throw new Error("Expected the native approval request identity.");
            yield* Deferred.succeed(approval, ApprovalRequestId.make(event.requestId));
          }
          if (event.type === "content.delta") {
            deltas.push(event.payload.delta);
            if (event.payload.delta === "Resumed foreground turn is running.") {
              yield* Deferred.succeed(resumedText, undefined);
            }
          }
          if (event.type === "thread.token-usage.updated") {
            usage.push(event.payload.usage.usedTokens ?? -1);
          }
          if (event.type === "thread.usage-accounting.updated") accounting.push(event.payload);
          if (event.type === "turn.completed" && event.payload.state === "completed") {
            yield* Deferred.succeed(completed, undefined);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      const opened = yield* adapter.startSession(start);
      assert.isDefined(opened.resumeCursor);
      const first = yield* adapter.sendTurn({ threadId, input: "Hello Gemini", modelSelection });
      assert.deepEqual(first.resolvedGeminiConfiguration, {
        model: "gemini-4-neon",
        effort: "low",
      });
      const requestId = yield* Deferred.await(approval);
      yield* adapter.respondToRequest(threadId, requestId, "acceptForSession").pipe(Effect.flip);
      yield* adapter.respondToRequest(threadId, requestId, "accept");
      yield* Deferred.await(completed);
      assert.deepEqual(deltas, ["Using low effort and one-time approval."]);
      assert.deepEqual(usage, [23]);
      assert.deepEqual(
        accounting.map(({ scopeId: _, ...sample }) => sample),
        [
          {
            revision: 1,
            completeness: "complete",
            models: [
              {
                model: "gemini-4-neon",
                inputTokens: 9_230,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 509,
                reasoningOutputTokens: 393,
              },
            ],
          },
        ],
      );
      yield* adapter.stopSession(threadId);

      yield* adapter
        .startSession({
          ...start,
          threadId: ThreadId.make("foreign-thread"),
          resumeCursor: opened.resumeCursor,
        })
        .pipe(Effect.flip);
      yield* adapter.startSession({ ...start, resumeCursor: opened.resumeCursor });
      const resumed = yield* adapter.sendTurn({ threadId, input: "Continue" });
      yield* Deferred.await(resumedText);
      yield* adapter.interruptTurn(threadId, TurnId.make("stale-turn"));
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.interruptTurn(threadId, resumed.turnId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "delivers attachment-only Markdown as validated text context without native image support",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const { adapter, threadId, start } = yield* makeFixtureAdapter({
        CAFE_GEMINI_FIXTURE_ECHO_PROMPT: "true",
      });
      const source = Buffer.from(
        "# Private reference\r\n\r\nMarkdown attachment café 日本語 😀\r\n",
      );
      const attachment = yield* Effect.promise(() =>
        storeFileAttachment({
          attachmentsDir: config.attachmentsDir,
          threadId,
          name: "reference.md",
          mimeType: "text/markdown",
          bytes: source,
        }),
      );
      const completed = yield* Deferred.make<void>();
      const replies: string[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "content.delta") replies.push(event.payload.delta);
          if (event.type === "turn.completed" && event.payload.state === "completed") {
            yield* Deferred.succeed(completed, undefined);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      // The synthetic native peer deliberately advertises no image capability.
      // Echoing the actual transported prompt keeps this assertion outside the
      // adapter: a valid file-only send must reach ACP as metadata-only text,
      // without inlining private bytes or requiring optional image support.
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({ threadId, attachments: [attachment] });
      yield* Deferred.await(completed);
      const blocks = decodeJsonText(replies.join("")) as Array<{ type: string; text: string }>;
      assert.lengthOf(blocks, 1);
      const block = blocks[0]!;
      assert.deepEqual(Object.keys(block).sort(), ["text", "type"]);
      assert.equal(block.type, "text");
      assert.notInclude(block.text, source.toString("utf8"));
      // The manifest's JSON inventory is the attachment contract. Surrounding
      // guidance can evolve without changing the file's identity or transport.
      const inventoryLine = block.text.split("\n").find((line) => /^\[.*\]$/u.test(line));
      assert.isDefined(inventoryLine);
      const inventory = decodeJsonText(inventoryLine!) as Array<Record<string, unknown>>;
      assert.lengthOf(inventory, 1);
      const entry = inventory[0]!;
      assert.deepInclude(entry, {
        name: "reference.md",
        mimeType: "text/markdown",
        sizeBytes: source.byteLength,
      });
      const providerPath = entry.path;
      assert.isString(providerPath);
      assert.equal(path.dirname(providerPath as string), config.attachmentsDir);
      assert.equal(path.extname(providerPath as string), ".md");
      assert.deepEqual(yield* Effect.promise(() => readFile(providerPath as string)), source);

      // A successful first delivery must not turn its derivative into authority
      // for later sends. Same-size replacement leaves all renderer metadata
      // intact, so only the stored content commitment can reject this change.
      const storage = fileAttachmentStoragePaths(config.attachmentsDir, attachment.id);
      yield* Effect.promise(() => writeFile(storage.data, Buffer.alloc(source.byteLength, 0x78)));
      const failure = yield* adapter
        .sendTurn({ threadId, attachments: [attachment] })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterValidationError");
      if (failure._tag === "ProviderAdapterValidationError") {
        assert.equal(failure.issue, "A Gemini file attachment could not be prepared.");
      }
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "keeps a Gemini turn active until its admitted follow-up and separates background output",
  () =>
    Effect.gen(function* () {
      const { adapter, threadId, modelSelection, start } = yield* makeFixtureAdapter();
      const initialOutput = yield* Deferred.make<void>();
      const firstFollowUpOutput = yield* Deferred.make<void>();
      const approval = yield* Deferred.make<ApprovalRequestId>();
      const terminal = yield* Deferred.make<void>();
      const nextTerminal = yield* Deferred.make<void>();
      const background = yield* Deferred.make<ProviderRuntimeEvent>();
      const events: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (
            event.type === "content.delta" &&
            event.payload.delta === "Initial foreground output."
          ) {
            yield* Deferred.succeed(initialOutput, undefined);
          }
          if (
            event.type === "content.delta" &&
            event.payload.delta === "Follow-up reached the agent."
          ) {
            yield* Deferred.succeed(firstFollowUpOutput, undefined);
          }
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(approval, ApprovalRequestId.make(event.requestId));
          }
          if (event.type === "turn.completed") {
            const target = (yield* Deferred.isDone(terminal)) ? nextTerminal : terminal;
            yield* Deferred.succeed(target, undefined);
          }
          if (
            event.type === "item.updated" &&
            event.payload.detail === "Background task finished."
          ) {
            yield* Deferred.succeed(background, event);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      yield* adapter.startSession(start);
      const root = yield* adapter.sendTurn({ threadId, input: "Start the steering fixture" });
      yield* Deferred.await(initialOutput);
      const followUp = yield* adapter.steerTurn({
        threadId,
        expectedTurnId: root.turnId,
        input: "Deliver this follow-up",
      });
      assert.equal(followUp.turnId, root.turnId);
      yield* Deferred.await(firstFollowUpOutput);
      const secondFollowUp = yield* adapter.steerTurn({
        threadId,
        expectedTurnId: root.turnId,
        input: "Deliver a second follow-up",
      });
      assert.equal(secondFollowUp.turnId, root.turnId);

      // The follow-up's actual native callback holds its RPC open after the
      // earlier RPCs have ended. No clock or mock of the adapter decides ordering.
      const request = yield* Deferred.await(approval);
      assert.isFalse(yield* Deferred.isDone(terminal));
      yield* adapter.respondToRequest(threadId, request, "accept");
      yield* Deferred.await(terminal);

      const next = yield* adapter.sendTurn({
        threadId,
        input: "Start the next foreground",
        modelSelection: { ...modelSelection, options: [{ id: "reasoningEffort", value: "high" }] },
      });
      const detached = yield* Deferred.await(background);
      yield* Deferred.await(nextTerminal);
      assert.equal(detached.turnId, root.turnId);
      assert.notEqual(next.turnId, root.turnId);

      const transcript = events.flatMap((event) => {
        if (event.turnId !== root.turnId) return [];
        if (event.type === "content.delta") return [event.payload.delta];
        if (event.type === "turn.completed") return [`terminal:${event.payload.state}`];
        return [];
      });
      assert.deepEqual(transcript, [
        "Initial foreground output.",
        "Follow-up reached the agent.",
        "Second follow-up reached the agent.",
        "terminal:completed",
      ]);
      const accounting = events.filter((event) => event.type === "thread.usage-accounting.updated");
      assert.deepEqual(
        accounting.map(({ turnId, payload: { scopeId: _, ...sample } }) => ({ turnId, ...sample })),
        [
          {
            turnId: root.turnId,
            revision: 1,
            completeness: "partial",
            models: [
              {
                model: "gemini-4-neon",
                inputTokens: 9_839,
                cachedInputTokens: 7_173,
                cacheWriteInputTokens: 0,
                outputTokens: 29,
                reasoningOutputTokens: 27,
              },
            ],
          },
        ],
      );
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "retains only an exact running workflow across root completion until its own terminal update",
  () =>
    Effect.gen(function* () {
      const { adapter, threadId, start } = yield* makeFixtureAdapter({
        CAFE_GEMINI_FIXTURE_BACKGROUND_WORKFLOW: "true",
      });
      const completed = yield* Deferred.make<void>();
      const nextCompleted = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") {
            const target = (yield* Deferred.isDone(completed)) ? nextCompleted : completed;
            yield* Deferred.succeed(target, undefined);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      yield* adapter.startSession(start);
      const root = yield* adapter.sendTurn({ threadId, input: "Start the background workflow" });
      yield* Deferred.await(completed);
      type ToolEvent = Extract<
        ProviderRuntimeEvent,
        { readonly type: "item.started" | "item.updated" | "item.completed" }
      >;
      const workflowEvents = () =>
        events.filter(
          (event): event is ToolEvent =>
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed") &&
            event.itemId?.startsWith("fixture-workflow-") === true,
        );

      // ACP pending and running statuses share Cafe's inProgress display
      // status. Only the independently observed native running status grants
      // the detached-work marker when this exact root normally completes.
      const initial = workflowEvents();
      assert.deepEqual(
        initial.map((event) => [event.type, String(event.itemId), event.payload.status]),
        [
          ["item.started", "fixture-workflow-running", "inProgress"],
          ["item.started", "fixture-workflow-pending", "inProgress"],
          ["item.started", "fixture-workflow-finished", "inProgress"],
          ["item.completed", "fixture-workflow-finished", "completed"],
          ["item.updated", "fixture-workflow-running", "inProgress"],
        ],
      );
      const started = initial[0]!;
      const promoted = initial.at(-1)!;
      assert.isDefined(started.subagentRuntimeId);
      assert.equal(promoted.subagentRuntimeId, started.subagentRuntimeId);
      assert.equal(promoted.turnId, root.turnId);
      assert.deepInclude(promoted.payload.data, { geminiDetachedToolVersion: 1 });
      for (const event of initial.slice(0, -1)) {
        assert.equal(event.turnId, root.turnId);
        assert.notProperty(event.payload.data ?? {}, "geminiDetachedToolVersion");
      }
      const rootCompleted = events.find(
        (event) => event.type === "turn.completed" && event.turnId === root.turnId,
      )!;
      assert.isBelow(events.indexOf(promoted), events.indexOf(rootCompleted));

      const next = yield* adapter.sendTurn({ threadId, input: "Continue the foreground" });
      yield* Deferred.await(nextCompleted);
      assert.notEqual(next.turnId, root.turnId);
      const terminals = workflowEvents().filter(
        (event) => event.type === "item.completed" && event.itemId === "fixture-workflow-running",
      );
      assert.lengthOf(terminals, 1);
      const terminal = terminals[0]!;
      assert.equal(terminal.turnId, root.turnId);
      assert.equal(terminal.subagentRuntimeId, started.subagentRuntimeId);
      assert.equal(terminal.payload.status, "completed");
      assert.deepInclude(terminal.payload.data, { geminiDetachedToolVersion: 1 });
      assert.lengthOf(
        workflowEvents().filter((event) => event.type === "item.updated"),
        1,
      );

      // The exact terminal must retire its binding once. Neither the already
      // completed tool nor the merely pending control can keep old-turn Stop
      // authority after that retirement or close the newer idle native owner.
      yield* adapter.interruptTurn(threadId, root.turnId);
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "handles native ACP form elicitation questions in bypass mode and routes custom and multi-select answers",
  () =>
    Effect.gen(function* () {
      const { adapter, threadId, start } = yield* makeFixtureAdapter();
      const requested =
        yield* Deferred.make<
          Extract<ProviderRuntimeEvent, { readonly type: "user-input.requested" }>
        >();
      const resolved =
        yield* Deferred.make<
          Extract<ProviderRuntimeEvent, { readonly type: "user-input.resolved" }>
        >();
      const completed = yield* Deferred.make<void>();
      const deltas: string[] = [];

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "user-input.requested") {
            yield* Deferred.succeed(requested, event);
          }
          if (event.type === "user-input.resolved") {
            yield* Deferred.succeed(resolved, event);
          }
          if (event.type === "content.delta") {
            deltas.push(event.payload.delta);
          }
          if (event.type === "turn.completed" && event.payload.state === "completed") {
            yield* Deferred.succeed(completed, undefined);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      yield* adapter.startSession({ ...start, interactionMode: "gemini-bypass" });
      yield* adapter.sendTurn({
        threadId,
        input: "Ask structured questions",
        interactionMode: "gemini-bypass",
      });

      const promptEvent = yield* Deferred.await(requested);
      assert.isDefined(promptEvent.requestId);
      assert.equal(promptEvent.payload.supportsUnanswered, true);
      assert.deepEqual(promptEvent.payload.questions, [
        {
          id: "q1",
          header: "Question",
          question: "Color?",
          multiSelect: false,
          options: [
            { label: "Red", description: "Red" },
            { label: "Blue", description: "Blue" },
          ],
        },
        {
          id: "q2",
          header: "Question",
          question: "Fruits?",
          multiSelect: true,
          options: [
            { label: "Apple", description: "Apple" },
            { label: "Banana", description: "Banana" },
            { label: "Pear", description: "Pear" },
          ],
        },
      ]);

      const requestId = ApprovalRequestId.make(promptEvent.requestId!);
      // An incomplete response must fail without consuming the pending question.
      yield* adapter.respondToUserInput(threadId, requestId, { q1: "Red" }).pipe(Effect.flip);
      yield* adapter.respondToUserInput(threadId, requestId, {
        q1: "Purple",
        q2: ["Apple", "Pear"],
      });

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload, {
        answers: {
          q1: "Purple",
          q2: ["Apple", "Pear"],
        },
      });
      yield* Deferred.await(completed);
      assert.deepEqual(deltas, ["Received Purple and Apple, Pear."]);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(configLayer)),
);
