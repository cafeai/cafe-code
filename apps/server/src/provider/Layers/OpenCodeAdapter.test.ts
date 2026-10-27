import * as ManagementMcp from "../../mcp/sessionConnection.ts";
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vitest";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import * as Deferred from "effect/Deferred";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  buildOpenCodePermissionRules,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const encodeFixtureJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeFixtureJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

/**
 * Optional SSE stream for cases whose events must arrive after a turn starts.
 * The fixed `subscribedEvents` replay is delivered first. A hand-written
 * iterator (not an async generator) lets `return()` settle a pending read
 * immediately, so stopping the session never waits for another event.
 */
function makeLiveEventFeed() {
  const pending: unknown[] = [];
  let waiter: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;
  return {
    push(...events: unknown[]) {
      for (const event of events) {
        const next = waiter;
        waiter = undefined;
        if (next) next({ value: event, done: false });
        else pending.push(event);
      }
    },
    end() {
      closed = true;
      waiter?.({ value: undefined, done: true });
      waiter = undefined;
    },
    isDrained() {
      // The adapter requests another SSE value only after handling the prior
      // one. A waiting read with an empty queue proves native dispatch drained.
      return pending.length === 0 && waiter !== undefined;
    },
    stream(replay: ReadonlyArray<unknown>): AsyncIterable<unknown> {
      pending.unshift(...replay);
      const iterator: AsyncIterator<unknown> = {
        next: () =>
          closed
            ? Promise.resolve({ value: undefined, done: true })
            : pending.length > 0
              ? Promise.resolve({ value: pending.shift(), done: false })
              : new Promise((resolve) => {
                  waiter = resolve;
                }),
        return: () => {
          closed = true;
          waiter?.({ value: undefined, done: true });
          waiter = undefined;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    },
  };
}

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

type NativeSession = {
  id: string;
  directory: string;
  permission: PermissionRuleset;
  parentID?: string;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    onAbort: null as (() => Promise<void>) | null,
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    summarizeCalls: [] as Array<unknown>,
    nativeSessions: new Map<string, NativeSession>(),
    getCalls: [] as Array<{ sessionID: string; directory?: string }>,
    updateCalls: [] as Array<{
      sessionID: string;
      directory?: string;
      permission: PermissionRuleset;
    }>,
    statuses: {} as Record<string, { type: "busy" | "idle" | "retry" }>,
    getSession: null as
      | ((sessionID: string, signal?: AbortSignal) => Promise<NativeSession | undefined>)
      | null,
    updateError: null as Error | null,
    ignorePermissionUpdate: false,
    summarize: ((_input: unknown, _signal?: AbortSignal) => Promise.resolve({ data: true })) as (
      input: unknown,
      signal?: AbortSignal,
    ) => Promise<{ data: boolean }>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    onClose: null as (() => void) | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
    liveEvents: null as ReturnType<typeof makeLiveEventFeed> | null,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.onAbort = null;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.summarizeCalls.length = 0;
    this.state.nativeSessions.clear();
    this.state.getCalls.length = 0;
    this.state.updateCalls.length = 0;
    this.state.statuses = {};
    this.state.getSession = null;
    this.state.updateError = null;
    this.state.ignorePermissionUpdate = false;
    this.state.summarize = () => Promise.resolve({ data: true });
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.onClose = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.liveEvents = null;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          runtimeMock.state.onClose?.();
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Unconditionally register a scope finalizer for test observability —
      // preserves the `closeCalls` / `closeError` probes that the existing
      // suites rely on. Production code never attaches a finalizer to an
      // external server (it simply returns `Effect.succeed(...)`).
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          runtimeMock.state.onClose?.();
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword, directory }) =>
    ({
      session: {
        create: async ({ permission }: { permission: PermissionRuleset }) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          const data = { id: `${baseUrl}/session`, directory, permission };
          runtimeMock.state.nativeSessions.set(data.id, data);
          return { data };
        },
        get: async (
          input: { sessionID: string; directory?: string },
          options?: { signal?: AbortSignal },
        ) => {
          runtimeMock.state.getCalls.push(input);
          return {
            data: runtimeMock.state.getSession
              ? await runtimeMock.state.getSession(input.sessionID, options?.signal)
              : runtimeMock.state.nativeSessions.get(input.sessionID),
          };
        },
        status: async () => ({ data: runtimeMock.state.statuses }),
        update: async (input: {
          sessionID: string;
          directory?: string;
          permission: PermissionRuleset;
        }) => {
          runtimeMock.state.updateCalls.push(input);
          if (runtimeMock.state.updateError) throw runtimeMock.state.updateError;
          const previous = runtimeMock.state.nativeSessions.get(input.sessionID);
          if (!previous || runtimeMock.state.ignorePermissionUpdate) return { data: previous };
          const data = {
            ...previous,
            permission: [...previous.permission, ...input.permission],
          };
          runtimeMock.state.nativeSessions.set(data.id, data);
          return { data };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          await runtimeMock.state.onAbort?.();
        },
        summarize: (input: unknown, options?: { signal?: AbortSignal }) => {
          runtimeMock.state.summarizeCalls.push(input);
          return runtimeMock.state.summarize(input, options?.signal);
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => ({
          stream: runtimeMock.state.liveEvents
            ? runtimeMock.state.liveEvents.stream(runtimeMock.state.subscribedEvents)
            : makeLiveEventFeed().stream(runtimeMock.state.subscribedEvents),
        }),
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
  upsertSubagentHistoryBinding: () => Effect.void,
  getSubagentHistoryBinding: () => Effect.succeed(Option.none()),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

let openCodeAdapterForTestCleanup: OpenCodeAdapterShape | undefined;
const IsolatedOpenCodeAdapterTestLayer = OpenCodeAdapterTestLayer.pipe(
  Layer.tap((context) =>
    Effect.sync(() => {
      openCodeAdapterForTestCleanup = Context.get(context, OpenCodeAdapter);
    }),
  ),
);

beforeEach(async () => {
  // `it.layer` intentionally reuses the expensive adapter layer for this suite. Clear its
  // session map between cases so shuffled test order cannot leak sessions or finalizers.
  runtimeMock.state.closeError = null;
  if (openCodeAdapterForTestCleanup) {
    await Effect.runPromise(Effect.exit(openCodeAdapterForTestCleanup.stopAll()));
  }
  runtimeMock.reset();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

async function waitForOpenCodeEventDrain(feed: ReturnType<typeof makeLiveEventFeed>) {
  for (let attempt = 0; attempt < 200 && !feed.isDrained(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(feed.isDrained(), true);
}

const drainOpenCodeEvents = (feed: ReturnType<typeof makeLiveEventFeed>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => waitForOpenCodeEventDrain(feed));
    yield* Effect.yieldNow;
  });

it.layer(IsolatedOpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect(
    "persists the native session through SQLite close and a fresh Cafe provider service",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-opencode-restart-" });
        const repositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
          Layer.provide(makeSqlitePersistenceLive(path.join(tempDir, "runtime.sqlite"))),
        );
        const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(repositoryLayer));
        const generation = () =>
          makeProviderServiceLive().pipe(
            Layer.provide(
              Layer.effect(
                ProviderAdapterRegistry,
                Effect.map(makeOpenCodeAdapter(openCodeAdapterTestSettings), (adapter) =>
                  makeAdapterRegistryMock({ [ProviderDriverKind.make("opencode")]: adapter }),
                ),
              ),
            ),
            Layer.provide(directoryLayer),
            Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
          );
        const threadId = asThreadId("thread-opencode-durable-restart");
        const instanceId = ProviderInstanceId.make("opencode");
        const initial = yield* Effect.gen(function* () {
          const service = yield* ProviderService;
          return yield* service.startSession(threadId, {
            threadId,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
            modelSelection: createModelSelection(instanceId, "openai/gpt-5"),
          });
        }).pipe(Effect.provide(generation()));
        const readBinding = Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          return Option.getOrThrow(yield* directory.getBinding(threadId));
        }).pipe(Effect.provide(directoryLayer));
        const stopped = yield* readBinding;
        assert.equal(stopped.status, "stopped");
        assert.deepEqual(stopped.resumeCursor, initial.resumeCursor);

        yield* Effect.gen(function* () {
          const service = yield* ProviderService;
          const resumed = yield* service.startSession(threadId, {
            threadId,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            modelSelection: createModelSelection(instanceId, "anthropic/claude-sonnet-4-5"),
          });
          assert.deepEqual(resumed.resumeCursor, initial.resumeCursor);
          yield* service.sendTurn({
            threadId,
            input: "Continue after restarting Cafe",
            modelSelection: createModelSelection(instanceId, "anthropic/claude-sonnet-4-5"),
          });
        }).pipe(Effect.provide(generation()));
        assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
        assert.equal(runtimeMock.state.getCalls.length, 1);
        assert.deepEqual(runtimeMock.state.promptCalls, [
          {
            sessionID: "http://127.0.0.1:9999/session",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            parts: [{ type: "text", text: "Continue after restarting Cafe" }],
          },
        ]);
        runtimeMock.state.nativeSessions.clear();
        const unavailable = yield* Effect.exit(
          Effect.gen(function* () {
            const service = yield* ProviderService;
            return yield* service.startSession(threadId, {
              threadId,
              providerInstanceId: instanceId,
              runtimeMode: "full-access",
            });
          }).pipe(Effect.provide(generation())),
        );
        assert.equal(Exit.isFailure(unavailable), true);
        assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
        assert.deepEqual((yield* readBinding).resumeCursor, initial.resumeCursor);
      }),
  );

  it.effect(
    "reopens the exact saved native session after adapter replacement and changes model in place",
    () =>
      Effect.gen(function* () {
        const first = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-restart");
        const initial = yield* first.startSession({
          threadId,
          runtimeMode: "full-access",
        });
        const resumeCursor = decodeFixtureJson(encodeFixtureJson(initial.resumeCursor)) as Record<
          string,
          unknown
        >;
        assert.deepEqual(resumeCursor, {
          schemaVersion: 1,
          sessionId: "http://127.0.0.1:9999/session",
          threadId,
          instanceId: "opencode",
          directory: process.cwd(),
          serverUrl: "http://127.0.0.1:9999",
        });
        yield* first.sendTurn({
          threadId,
          input: "Remember the existing conversation",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        yield* first.stopAll();

        const replacement = yield* makeOpenCodeAdapter(openCodeAdapterTestSettings);
        const resumed = yield* replacement.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor,
        });
        const next = yield* replacement.sendTurn({
          threadId,
          input: "Continue",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        });
        assert.deepEqual(resumed.resumeCursor, resumeCursor);
        assert.deepEqual(next.resumeCursor, resumeCursor);
        assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
        assert.deepEqual(runtimeMock.state.getCalls, [
          {
            sessionID: resumeCursor.sessionId,
            directory: process.cwd(),
          },
        ]);
        assert.equal(runtimeMock.state.updateCalls.length, 0);
        assert.deepEqual(runtimeMock.state.promptCalls, [
          {
            sessionID: resumeCursor.sessionId,
            model: { providerID: "openai", modelID: "gpt-5" },
            parts: [{ type: "text", text: "Remember the existing conversation" }],
          },
          {
            sessionID: resumeCursor.sessionId,
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            parts: [{ type: "text", text: "Continue" }],
          },
        ]);
      }),
  );

  it.effect(
    "reapplies and verifies a stricter permission mode without replacing native history",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-permission-resume");
        const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.stopAll();
        const resumed = yield* adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
          resumeCursor: initial.resumeCursor,
        });
        assert.equal(resumed.runtimeMode, "approval-required");
        assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
        assert.deepEqual(runtimeMock.state.updateCalls, [
          {
            sessionID: "http://127.0.0.1:9999/session",
            directory: process.cwd(),
            permission: buildOpenCodePermissionRules("approval-required"),
          },
        ]);
        yield* adapter.stopAll();
        yield* adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
          resumeCursor: resumed.resumeCursor,
        });
        assert.equal(runtimeMock.state.updateCalls.length, 1);
      }),
  );

  for (const failure of [
    "missing session",
    "different session",
    "different directory",
    "child session",
    "busy session",
    "retrying session",
    "lookup error",
    "permission error",
    "unconfirmed permission",
  ]) {
    it.effect(`preserves saved history without a blank fallback after ${failure}`, () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-resume-refusal");
        const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.stopAll();
        const sessionId = "http://127.0.0.1:9999/session";
        const stored = runtimeMock.state.nativeSessions.get(sessionId)!;
        switch (failure) {
          case "missing session":
            runtimeMock.state.nativeSessions.delete(sessionId);
            break;
          case "different session":
            stored.id = "another-session";
            break;
          case "different directory":
            stored.directory = "/another-workspace";
            break;
          case "child session":
            stored.parentID = "another-session";
            break;
          case "busy session":
            runtimeMock.state.statuses[sessionId] = { type: "busy" };
            break;
          case "retrying session":
            runtimeMock.state.statuses[sessionId] = { type: "retry" };
            break;
          case "lookup error":
            runtimeMock.state.getSession = () =>
              Promise.reject(new Error("private-provider-response"));
            break;
          case "permission error":
            runtimeMock.state.updateError = new Error("private-provider-response");
            break;
          case "unconfirmed permission":
            runtimeMock.state.ignorePermissionUpdate = true;
            break;
        }
        const result = yield* Effect.exit(
          adapter.startSession({
            threadId,
            runtimeMode: "approval-required",
            resumeCursor: initial.resumeCursor,
          }),
        );
        assert.equal(Exit.isFailure(result), true);
        if (Exit.isFailure(result))
          assert.doesNotMatch(String(result.cause), /private-provider-response/);
        assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
        assert.equal(runtimeMock.state.closeCalls.length, 2);
        assert.equal(runtimeMock.state.abortCalls.length, 1);
        assert.equal(runtimeMock.state.promptCalls.length, 0);
        assert.deepEqual(yield* adapter.listSessions(), []);
      }),
    );
  }

  it.effect(
    "rejects malformed and foreign resume identities before retiring a live session or performing native I/O",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-bound-resume");
        const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const cursor = initial.resumeCursor as Record<string, unknown>;
        for (const resumeCursor of [
          {},
          [],
          "legacy-unknown",
          { ...cursor, schemaVersion: 2 },
          { ...cursor, threadId: "another-chat" },
          { ...cursor, instanceId: "another-opencode" },
          { ...cursor, directory: "/another-workspace" },
          { ...cursor, serverUrl: "https://another-server.invalid" },
          { ...cursor, sessionId: "" },
          { ...cursor, sessionId: "x".repeat(513) },
        ]) {
          const result = yield* Effect.exit(
            adapter.startSession({ threadId, runtimeMode: "full-access", resumeCursor }),
          );
          assert.equal(Exit.isFailure(result), true);
          assert.deepEqual(yield* adapter.listSessions(), [initial]);
        }
        assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
        assert.equal(runtimeMock.state.getCalls.length, 0);
        assert.equal(runtimeMock.state.abortCalls.length, 0);
        assert.equal(runtimeMock.state.closeCalls.length, 0);
      }),
  );

  it.effect("cancels a held resume lookup and closes its connection before returning", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-cancelled-resume");
      const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.stopAll();
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      runtimeMock.state.getSession = (_sessionId, signal) => {
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            Effect.runSync(Deferred.succeed(cancelled, undefined));
            reject(new Error("private-cancelled-provider-response"));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          Effect.runSync(Deferred.succeed(entered, undefined));
        });
      };
      const pending = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access", resumeCursor: initial.resumeCursor })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(pending);
      yield* Deferred.await(cancelled);
      assert.equal(runtimeMock.state.closeCalls.length, 2);
      assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
      assert.equal(runtimeMock.state.promptCalls.length, 0);
      assert.equal(runtimeMock.state.updateCalls.length, 0);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }),
  );

  it.effect("refuses a concurrent resume without aborting the winning native session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-concurrent-resume");
      const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.stopAll();
      const entered = yield* Deferred.make<void>();
      const gate = Promise.withResolvers<NativeSession | undefined>();
      const saved = runtimeMock.state.nativeSessions.get("http://127.0.0.1:9999/session");
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve(saved)));
      runtimeMock.state.getSession = () => {
        Effect.runSync(Deferred.succeed(entered, undefined));
        return gate.promise;
      };
      const pending = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access", resumeCursor: initial.resumeCursor })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const duplicate = yield* Effect.exit(
        adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: initial.resumeCursor,
        }),
      );
      assert.equal(Exit.isFailure(duplicate), true);
      assert.equal(runtimeMock.state.getCalls.length, 1);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
      yield* Effect.sync(() => gate.resolve(saved));
      const resumed = yield* Fiber.join(pending);
      assert.deepEqual(resumed.resumeCursor, initial.resumeCursor);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
      assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
    }),
  );

  it.effect("joins native retirement before reopening the same saved session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-retirement-resume");
      const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const entered = yield* Deferred.make<void>();
      const openingEntered = yield* Deferred.make<void>();
      const gate = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
      runtimeMock.state.onAbort = () => {
        Effect.runSync(Deferred.succeed(entered, undefined));
        return gate.promise;
      };
      const stopping = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const opening = yield* Deferred.succeed(openingEntered, undefined).pipe(
        Effect.andThen(
          adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            resumeCursor: initial.resumeCursor,
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(openingEntered);
      yield* Effect.yieldNow;
      assert.equal(runtimeMock.state.getCalls.length, 0);
      assert.equal(runtimeMock.state.closeCalls.length, 0);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
      yield* Effect.sync(() => gate.resolve());
      yield* Fiber.join(stopping);
      const resumed = yield* Fiber.join(opening);
      assert.deepEqual(resumed.resumeCursor, initial.resumeCursor);
      assert.equal(runtimeMock.state.getCalls.length, 1);
      assert.equal(runtimeMock.state.closeCalls.length, 1);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
      assert.deepEqual(yield* adapter.listSessions(), [resumed]);
    }),
  );

  it.effect("retires a connection whose event stream ends and keeps its resume identity", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-ended-stream");
      const feed = makeLiveEventFeed();
      runtimeMock.state.liveEvents = feed;
      const closed = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      runtimeMock.state.onClose = () => Effect.runSync(Deferred.succeed(closed, undefined));
      const received: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            received.push(event);
            if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
          }),
        ),
        Effect.forkChild,
      );
      const initial = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      feed.end();
      yield* Deferred.await(closed);
      yield* Deferred.await(exited);
      if (yield* adapter.hasSession(threadId)) yield* adapter.stopSession(threadId);
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
      assert.equal(received.filter((event) => event.type === "session.exited").length, 1);
      assert.equal(
        received.some(
          (event) =>
            event.type === "runtime.error" &&
            /stream ended unexpectedly/.test(event.payload.message),
        ),
        true,
      );
      runtimeMock.state.liveEvents = null;
      const resumed = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: initial.resumeCursor,
      });
      assert.deepEqual(resumed.resumeCursor, initial.resumeCursor);
      assert.equal(runtimeMock.state.sessionCreateUrls.length, 1);
    }),
  );

  it.effect("rejects a stale Stop before aborting a newer active turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale-stop");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const sent = yield* adapter.sendTurn({ threadId, input: "Current work" });
      const stale = yield* Effect.exit(
        adapter.interruptTurn(threadId, TurnId.make("previous-turn")),
      );
      assert.equal(Exit.isFailure(stale), true);
      assert.equal(runtimeMock.state.abortCalls.length, 0);
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, sent.turnId);
      yield* adapter.interruptTurn(threadId, sent.turnId);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
    }),
  );

  for (const ordering of [
    "before-abort-response",
    "after-abort-response",
    "idle-first",
    "native-only",
  ] as const) {
    it.effect(`classifies native message aborts as interruption (${ordering})`, () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId(`thread-opencode-stop-${ordering}`);
        const sessionID = "http://127.0.0.1:9999/session";
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const events: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const { turnId } = yield* adapter.sendTurn({ threadId, input: "Work until stopped" });
        const aborted = {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "MessageAbortedError", data: { message: "private-abort-body" } },
          },
        };
        const idle = {
          type: "session.status",
          properties: { sessionID, status: { type: "idle" } },
        };
        if (ordering === "before-abort-response" || ordering === "idle-first") {
          runtimeMock.state.onAbort = async () => {
            feed.push(...(ordering === "idle-first" ? [idle, aborted] : [aborted, idle]));
            await waitForOpenCodeEventDrain(feed);
          };
        }
        if (ordering !== "native-only") yield* adapter.interruptTurn(threadId, turnId);
        if (ordering === "after-abort-response" || ordering === "native-only")
          feed.push(aborted, idle);
        // Repeated abort/idle notifications must not add another terminal edge.
        feed.push(aborted, idle);
        yield* drainOpenCodeEvents(feed);
        const terminal = events.filter(
          (event) => event.type === "turn.aborted" || event.type === "turn.completed",
        );
        assert.deepEqual(
          terminal.map((event) => [event.type, event.turnId]),
          [["turn.aborted", turnId]],
        );
        assert.equal(
          events.some((event) => event.type === "runtime.error"),
          false,
        );
        const session = (yield* adapter.listSessions())[0];
        assert.equal(session?.status, "ready");
        assert.equal(session?.activeTurnId, undefined);
        assert.equal(session?.lastError, undefined);
        assert.doesNotMatch(encodeFixtureJson(events), /private-abort-body/);
        yield* adapter.interruptTurn(threadId);
        assert.equal(runtimeMock.state.abortCalls.length, ordering === "native-only" ? 0 : 1);
      }),
    );
  }

  it.effect(
    "keeps late abort and idle echoes on the stopped turn until the next native busy edge",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-stop-echo");
        const sessionID = "http://127.0.0.1:9999/session";
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const events: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const first = yield* adapter.sendTurn({ threadId, input: "First work" });
        yield* adapter.interruptTurn(threadId, first.turnId);
        const next = yield* adapter.sendTurn({ threadId, input: "Continue with new work" });
        const aborted = {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        };
        const idle = {
          type: "session.status",
          properties: { sessionID, status: { type: "idle" } },
        };
        const busy = {
          type: "session.status",
          properties: { sessionID, status: { type: "busy" } },
        };
        // The stream can still be draining the previous turn's initial busy,
        // aborted error, processor idle and runner idle after HTTP Stop returned.
        feed.push(busy, aborted, idle, aborted, idle);
        yield* drainOpenCodeEvents(feed);
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, next.turnId);
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
        assert.equal(
          events.some((event) => event.type === "runtime.error"),
          false,
        );
        assert.deepEqual(
          events.filter((event) => event.type === "turn.aborted").map((event) => event.turnId),
          [first.turnId],
        );
        // A genuine abort of the next native generation is still an interruption.
        feed.push(busy, aborted, idle);
        yield* drainOpenCodeEvents(feed);
        assert.deepEqual(
          events.filter((event) => event.type === "turn.aborted").map((event) => event.turnId),
          [first.turnId, next.turnId],
        );
        assert.equal(
          events.some((event) => event.type === "runtime.error"),
          false,
        );
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      }),
  );

  for (const errorName of ["ProviderAuthError", "UnknownError"] as const) {
    it.effect(`preserves genuine provider errors during Stop (${errorName})`, () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId(`thread-opencode-stop-error-${errorName}`);
        const sessionID = "http://127.0.0.1:9999/session";
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const events: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const { turnId } = yield* adapter.sendTurn({ threadId, input: "Run" });
        runtimeMock.state.onAbort = async () => {
          feed.push(
            {
              type: "session.error",
              properties: {
                sessionID,
                error: {
                  name: errorName,
                  data: { providerID: "fixture", message: "Aborted private-provider-body" },
                },
              },
            },
            { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
          );
          await waitForOpenCodeEventDrain(feed);
        };
        yield* adapter.interruptTurn(threadId, turnId);
        yield* drainOpenCodeEvents(feed);
        assert.equal(events.filter((event) => event.type === "runtime.error").length, 1);
        assert.equal(
          events.some((event) => event.type === "turn.aborted"),
          false,
        );
        assert.equal(
          events.some(
            (event) =>
              event.type === "turn.completed" &&
              event.turnId === turnId &&
              event.payload.state === "failed",
          ),
          true,
        );
        assert.equal((yield* adapter.listSessions())[0]?.status, "error");
        assert.doesNotMatch(encodeFixtureJson(events), /private-provider-body/);
      }),
    );
  }

  it.effect(
    "preserves an active turn when the abort request fails without native cancellation",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-stop-request-failed");
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const events: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const { turnId } = yield* adapter.sendTurn({ threadId, input: "Run" });
        runtimeMock.state.onAbort = async () => {
          throw new Error("private-abort-request-failure");
        };
        const rejected = yield* Effect.exit(adapter.interruptTurn(threadId, turnId));
        assert.equal(Exit.isFailure(rejected), true);
        assert.equal(
          events.some((event) => event.type === "turn.aborted" || event.type === "turn.completed"),
          false,
        );
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turnId);
        feed.push({
          type: "session.status",
          properties: { sessionID: "http://127.0.0.1:9999/session", status: { type: "idle" } },
        });
        yield* drainOpenCodeEvents(feed);
        const terminal = events.find((event) => event.type === "turn.completed");
        assert.equal(terminal?.type === "turn.completed" && terminal.payload.state, "completed");
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      }),
  );

  it.effect(
    "classifies native session errors without publishing or logging raw provider responses",
    () =>
      Effect.gen(function* () {
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const nativeRecords: unknown[] = [];
        const adapter = yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger: {
            filePath: "fixture-native-events.ndjson",
            write: (record) =>
              Effect.sync(() => {
                nativeRecords.push(record);
              }),
            close: () => Effect.void,
          },
        });
        const observed = yield* Deferred.make<void>();
        const received: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              received.push(event);
              if (event.type === "runtime.error") yield* Deferred.succeed(observed, undefined);
            }),
          ),
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-opencode-private-error");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "Continue" });
        feed.push({
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: {
              name: "ProviderAuthError",
              data: {
                providerID: "fixture",
                message: "private-fixture-secret",
                headers: { authorization: "private-fixture-secret" },
              },
            },
          },
        });
        yield* Deferred.await(observed);
        assert.doesNotMatch(encodeFixtureJson(received), /private-fixture-secret/);
        assert.doesNotMatch(encodeFixtureJson(nativeRecords), /private-fixture-secret/);
        assert.equal(
          received.some(
            (event) =>
              event.type === "turn.completed" &&
              event.turnId === turn.turnId &&
              event.payload.state === "failed",
          ),
          true,
        );
        assert.match((yield* adapter.listSessions())[0]?.lastError ?? "", /authentication failed/);
      }),
  );

  it.effect(
    "refuses private image paths for a separately hosted OpenCode server before paid input",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-remote-image");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const rejected = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "Inspect image",
            attachments: [
              {
                type: "image",
                id: "not-dereferenced",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          }),
        );
        assert.equal(Exit.isFailure(rejected), true);
        assert.equal(runtimeMock.state.promptCalls.length, 0);
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      }),
  );

  it.effect(
    "adds management MCP only to the chat-owned OpenCode server and cleans it up on stop",
    () =>
      Effect.gen(function* () {
        const launch = {
          command: process.execPath,
          args: ["inert-bridge.mjs", "inert-connection.json"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
        let disposed = false;
        const binding = {
          name: "cafe-code-fixture",
          launch,
          dispose: Effect.sync(() => {
            disposed = true;
          }),
        };
        const spy = vi
          .spyOn(ManagementMcp, "makeManagementMcpSession")
          .mockReturnValue(Effect.succeed(binding));
        const connect = vi.spyOn(OpenCodeRuntimeTestDouble, "connectToOpenCodeServer");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            spy.mockRestore();
            connect.mockRestore();
          }),
        );
        const hosted = yield* OpenCodeAdapter;
        yield* hosted.startSession({
          threadId: asThreadId("hosted-mcp"),
          runtimeMode: "approval-required",
        });
        assert.equal(spy.mock.calls.length, 0);
        assert.equal(connect.mock.calls.at(-1)?.[0].managementMcp, undefined);
        const local = yield* makeOpenCodeAdapter(
          Schema.decodeSync(OpenCodeSettings)({ binaryPath: "fake-opencode" }),
        );
        const threadId = asThreadId("local-mcp");
        yield* local.startSession({ threadId, runtimeMode: "approval-required" });
        assert.equal(connect.mock.calls.at(-1)?.[0].managementMcp?.name, binding.name);
        assert.equal(spy.mock.calls.length, 1);
        yield* local.stopSession(threadId);
        assert.equal(disposed, true);
      }),
  );

  it.effect(
    "uses native compaction without sending a prompt and releases admission on completion",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("compact-success");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });
        let finish!: (value: { data: boolean }) => void;
        runtimeMock.state.summarize = () =>
          new Promise((resolve) => {
            finish = resolve;
          });
        yield* adapter.compactThread!(threadId);
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
        assert.equal(runtimeMock.state.summarizeCalls.length, 1);
        assert.deepEqual(runtimeMock.state.summarizeCalls[0], {
          sessionID: "http://127.0.0.1:9999/session",
          directory: process.cwd(),
          providerID: "openai",
          modelID: "gpt-5",
          auto: false,
        });
        const duplicate = yield* Effect.exit(adapter.compactThread!(threadId));
        assert.equal(Exit.isFailure(duplicate), true);
        const send = yield* Effect.exit(adapter.sendTurn({ threadId, input: "overlap" }));
        assert.equal(Exit.isFailure(send), true);
        assert.equal(runtimeMock.state.promptCalls.length, 0);
        finish({ data: true });
        yield* Effect.promise(() => Promise.resolve());
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
      }),
  );

  it.effect(
    "interrupts manual compaction through native abort notifications and ignores a late HTTP completion",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("compact-interrupt");
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const events: ProviderRuntimeEvent[] = [];
        const interrupted = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "turn.completed") yield* Deferred.succeed(interrupted, undefined);
            }),
          ),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });
        let finish!: (value: { data: boolean }) => void;
        let signal: AbortSignal | undefined;
        runtimeMock.state.summarize = (_input, value) => {
          signal = value;
          return new Promise((resolve) => {
            finish = resolve;
          });
        };
        yield* adapter.compactThread!(threadId);
        yield* Effect.yieldNow;
        runtimeMock.state.onAbort = async () => {
          feed.push(
            {
              type: "session.error",
              properties: {
                sessionID: "http://127.0.0.1:9999/session",
                error: { name: "MessageAbortedError", data: { message: "Aborted" } },
              },
            },
            {
              type: "session.status",
              properties: { sessionID: "http://127.0.0.1:9999/session", status: { type: "idle" } },
            },
          );
          await waitForOpenCodeEventDrain(feed);
        };
        yield* adapter.interruptTurn(threadId);
        yield* Deferred.await(interrupted);
        assert.equal(signal?.aborted, true);
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        const terminal = events.filter((event) => event.type === "turn.completed");
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0]?.payload.state, "interrupted");
        assert.equal(
          events.some((event) => event.type === "runtime.error"),
          false,
        );
        const sent = yield* adapter.sendTurn({ threadId, input: "continue" });
        finish({ data: true });
        yield* Effect.promise(() => Promise.resolve());
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, sent.turnId);
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
        runtimeMock.state.onAbort = null;
      }),
  );

  it.effect("reports compaction failures without exposing raw provider errors", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("compact-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt-5" },
      });
      const terminal = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      runtimeMock.state.summarize = () => Promise.reject(new Error("private upstream detail"));
      yield* adapter.compactThread!(threadId);
      yield* Fiber.join(terminal).pipe(Effect.timeout("1 second"));
      const session = (yield* adapter.listSessions())[0];
      assert.equal(session?.status, "ready");
      assert.equal(
        session?.lastError,
        "OpenCode compaction failed. Try again when the provider is available.",
      );
    }),
  );

  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "opencode");
      assert.equal(session.threadId, "thread-opencode");
      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      assert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );
  it.effect(
    "rejects local file handles for an explicitly hosted OpenCode server instead of claiming delivery",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("hosted-opencode-file");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "inspect this file",
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencode"),
              model: "openai/gpt-5",
            },
            attachments: [
              {
                type: "file",
                id: "not-dereferenced",
                name: "source.html",
                mimeType: "text/html",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterValidationError");
        assert.match(error.message, /locally managed OpenCode runtime/);
        assert.deepEqual(runtimeMock.state.promptCalls, []);
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      assert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      assert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        assert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(
        error.detail,
        "OpenCode request failed. Check the provider configuration and server availability.",
      );
      assert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: OpenCode request failed. Check the provider configuration and server availability.",
      );
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
      assert.equal(sessions[0]?.lastError, error.detail);
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      assert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      assert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      assert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      assert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      assert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      assert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        assert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect(
    "publishes bounded, coalesced OpenCode thinking rows and settles them at native completion or Stop",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-thinking");
        const sessionID = "http://127.0.0.1:9999/session";
        const feed = makeLiveEventFeed();
        runtimeMock.state.liveEvents = feed;
        const received: ProviderRuntimeEvent[] = [];
        yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          Effect.forkChild,
        );
        type ReasoningItemEvent = Extract<
          ProviderRuntimeEvent,
          { type: "item.updated" | "item.completed" }
        >;
        const reasoningEvents = () =>
          received.filter(
            (event): event is ReasoningItemEvent =>
              (event.type === "item.updated" || event.type === "item.completed") &&
              event.payload.itemType === "reasoning",
          );
        // The SSE generator and runtime queue settle on real macrotasks.
        const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        const waitFor = (predicate: () => boolean) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) yield* settle;
            assert.equal(predicate(), true);
          });

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const { turnId } = yield* adapter.sendTurn({
          threadId,
          input: "Why does the test fail?",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });
        const part = {
          id: "prt_reasoning_1",
          sessionID,
          messageID: "msg-thinking",
          type: "reasoning",
          text: "",
          metadata: { openai: { reasoningEncryptedContent: "never-disclosed" } },
          time: { start: 1_700_000_000_000 },
        };
        feed.push(
          {
            type: "message.updated",
            properties: { sessionID, info: { id: "msg-thinking", role: "assistant" } },
          },
          { type: "message.part.updated", properties: { sessionID, part, time: 1 } },
          {
            type: "message.part.delta",
            properties: {
              sessionID,
              messageID: "msg-thinking",
              partID: part.id,
              field: "text",
              delta: "Checking the",
            },
          },
        );
        // The first disclosed text is published immediately.
        yield* waitFor(() => reasoningEvents().length === 1);
        feed.push({
          type: "message.part.delta",
          properties: {
            sessionID,
            messageID: "msg-thinking",
            partID: part.id,
            field: "text",
            delta: " fixture",
          },
        });
        yield* waitFor(() =>
          received.some(
            (event) => event.type === "content.delta" && event.payload.delta === " fixture",
          ),
        );
        // Later edits coalesce behind the one-second interval.
        assert.equal(reasoningEvents().length, 1);
        yield* advanceTestClock(1_000);
        yield* waitFor(() => reasoningEvents().length === 2);
        feed.push({
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              ...part,
              text: "Checking the fixture.\n",
              time: { start: part.time.start, end: 2 },
            },
            time: 2,
          },
        });
        yield* waitFor(() => reasoningEvents().length === 3);
        // Re-delivering the whole message cannot reopen a settled row.
        feed.push({
          type: "message.updated",
          properties: { sessionID, info: { id: "msg-thinking", role: "assistant" } },
        });
        const oversized = {
          ...part,
          id: "prt_reasoning_2",
          text: "x".repeat(5_000),
          time: { start: 1_700_000_000_500 },
        };
        feed.push({
          type: "message.part.updated",
          properties: { sessionID, part: oversized, time: 3 },
        });
        yield* waitFor(() => reasoningEvents().length === 4);
        // Stop settles the unfinished trace as partial before the abort.
        yield* adapter.interruptTurn(threadId, turnId);
        yield* waitFor(() => received.some((event) => event.type === "turn.aborted"));

        const events = reasoningEvents();
        assert.deepEqual(
          events.map((event) => [
            event.type,
            event.itemId,
            event.payload.status,
            event.payload.detail?.length,
          ]),
          [
            ["item.updated", "prt_reasoning_1", "inProgress", "Checking the".length],
            ["item.updated", "prt_reasoning_1", "inProgress", "Checking the fixture".length],
            ["item.completed", "prt_reasoning_1", "completed", "Checking the fixture.".length],
            ["item.updated", "prt_reasoning_2", "inProgress", 4_096],
            ["item.completed", "prt_reasoning_2", "failed", 4_096],
          ],
        );
        assert.equal(events[2]?.payload.detail, "Checking the fixture.");
        for (const event of events) {
          assert.equal(event.turnId, turnId);
          // Raw native parts (and their encrypted metadata) never travel along:
          // only the admitted presentation fields are emitted.
          assert.equal(event.raw, undefined);
          assert.deepEqual(Object.keys(event.payload).sort(), [
            "data",
            "detail",
            "itemType",
            "status",
            "title",
          ]);
        }
        // The native part start (1_700_000_000_000 ms) keeps the row in place.
        assert.equal(events[0]?.createdAt, "2023-11-14T22:13:20.000Z");
        assert.deepEqual(events[0]?.payload.data, {
          summaryVersion: 1,
          streamKind: "reasoning_summary_text",
          truncated: false,
        });
        assert.deepEqual(events[4]?.payload.data, {
          summaryVersion: 1,
          streamKind: "reasoning_summary_text",
          truncated: true,
        });
        const abortedIndex = received.findIndex((event) => event.type === "turn.aborted");
        assert.ok(received.indexOf(events[4]!) < abortedIndex);
      }),
  );

  it.effect("keeps thinking live beyond sixteen refreshes and the retained text window", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-long-thinking");
      const sessionID = "http://127.0.0.1:9999/session";
      const feed = makeLiveEventFeed();
      runtimeMock.state.liveEvents = feed;
      const received: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) => Effect.sync(() => received.push(event))),
        Effect.forkChild,
      );
      const snapshots = () =>
        received.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "item.updated" }> =>
            event.type === "item.updated" && event.payload.itemType === "reasoning",
        );
      const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      const waitFor = (predicate: () => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) yield* settle;
          assert.equal(predicate(), true);
        });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const { turnId } = yield* adapter.sendTurn({
        threadId,
        input: "Inspect a long operation",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      const part = {
        id: "prt_long_thinking",
        sessionID,
        messageID: "msg-long-thinking",
        type: "reasoning",
        text: "First",
        time: { start: 1_700_000_000_000 },
      };
      feed.push(
        {
          type: "message.updated",
          properties: { sessionID, info: { id: part.messageID, role: "assistant" } },
        },
        { type: "message.part.updated", properties: { sessionID, part, time: 1 } },
      );
      yield* waitFor(() => snapshots().length === 1);
      let fullText = part.text;
      const deltas = [
        ...Array.from({ length: 20 }, (_, index) => ` step-${index}`),
        " x".repeat(3_000),
        " latest progress",
      ];
      for (const [index, delta] of deltas.entries()) {
        fullText += delta;
        feed.push({
          type: "message.part.delta",
          properties: {
            sessionID,
            messageID: part.messageID,
            partID: part.id,
            field: "text",
            delta,
          },
        });
        yield* waitFor(() =>
          received.some((event) => event.type === "content.delta" && event.payload.delta === delta),
        );
        // No per-token publication; each changed window arrives on its timer.
        assert.equal(snapshots().length, index + 1);
        yield* advanceTestClock(1_000);
        yield* waitFor(() => snapshots().length === index + 2);
        const snapshot = snapshots().at(-1)!;
        assert.equal(snapshot.payload.detail, fullText.slice(-4_096).trim());
        assert.deepEqual(snapshot.payload.data, {
          summaryVersion: 1,
          streamKind: "reasoning_summary_text",
          truncated: fullText.length > 4_096,
        });
        assert.equal(snapshot.turnId, turnId);
        assert.equal(snapshot.itemId, part.id);
        assert.equal(snapshot.createdAt, "2023-11-14T22:13:20.000Z");
        assert.equal(snapshot.raw, undefined);
      }
      // These updates must arrive while the native block is still open.
      assert.equal(
        received.some((event) => event.type === "item.completed"),
        false,
      );
      yield* adapter.interruptTurn(threadId, turnId);
      yield* waitFor(() => received.some((event) => event.type === "turn.aborted"));
      const settled = received.find(
        (event) => event.type === "item.completed" && event.payload.itemType === "reasoning",
      );
      assert.equal(
        settled?.type === "item.completed" && settled.payload.detail,
        fullText.slice(-4_096).trim(),
      );
      assert.ok(
        received.indexOf(settled!) < received.findIndex((event) => event.type === "turn.aborted"),
      );
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(session.threadId, "thread-native-log");
      assert.equal(nativeEvents.length, 1);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      assert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
