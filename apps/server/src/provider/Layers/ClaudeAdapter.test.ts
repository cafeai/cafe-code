// @effect-diagnostics nodeBuiltinImport:off
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKUserMessage,
  SessionMessage,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { forkSession as forkClaudeSdkSession } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  MessageId,
  ClaudeSettings,
  ProviderDriverKind,
  ProviderItemId,
  ProviderRuntimeEvent,
  type RuntimeMode,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  PROVIDER_SESSION_TITLE_MAX_CHARS,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { storeFileAttachment } from "../../fileAttachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { installSchedulingSessionBroker } from "../../scheduledFollowups/sessionRuntime.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  claudeProjectDirectoryName,
  encodeClaudeProjectDirectoryName,
  makeClaudeAdapter,
  resolveClaudeModelSessionOptions,
  type ClaudeAdapterLiveOptions,
} from "./ClaudeAdapter.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  public supportedCommands?: () => Promise<unknown>;
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly stopTaskCalls: string[] = [];
  public readonly backgroundTaskCalls: string[] = [];
  public backgroundTaskResult = true;
  public taskControlFailure: unknown = undefined;
  readonly stopTask = async (taskId: string): Promise<void> => {
    this.stopTaskCalls.push(taskId);
    if (this.taskControlFailure) throw this.taskControlFailure;
  };
  readonly backgroundTasks = async (toolUseId: string): Promise<boolean> => {
    this.backgroundTaskCalls.push(toolUseId);
    if (this.taskControlFailure) throw this.taskControlFailure;
    return this.backgroundTaskResult;
  };
  public readonly cancelAsyncMessageCalls: Array<string> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public interruptResponse: SDKControlInterruptResponse | undefined;
  public cancelAsyncMessageResult = true;
  public closeCalls = 0;
  public waitForExitCalls = 0;
  public exitFailure: unknown = undefined;
  public beforeExit: (() => void) | undefined;

  readonly waitForExit = async (): Promise<void> => {
    this.waitForExitCalls += 1;
    this.beforeExit?.();
    if (this.exitFailure !== undefined) throw this.exitFailure;
    if (!this.done) throw new Error("Synthetic query has not exited.");
  };

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (): Promise<SDKControlInterruptResponse | undefined> => {
    this.interruptCalls.push(undefined);
    return this.interruptResponse;
  };

  async cancelAsyncMessage(messageUuid: string): Promise<boolean> {
    this.cancelAsyncMessageCalls.push(messageUuid);
    return this.cancelAsyncMessageResult;
  }

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly setMaxThinkingTokens = async (
    maxThinkingTokens: number | null,
    _thinkingDisplay?: "summarized" | "omitted" | null,
  ): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    if (this.closeFailure !== undefined) throw this.closeFailure;
    this.finish();
  };

  closeFailure: unknown = undefined;

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

/** Complete terminal fixture: avoid disguising incomplete results with casts. */
function makeSuccessfulClaudeResult(sessionId: string): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "global",
      input_tokens: 0,
      iterations: [],
      output_tokens: 0,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "standard",
      speed: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-000000000000",
  };
}

function makeHarness(config?: {
  readonly nativeVersion?: string;
  readonly subagentConcurrencySupported?: boolean;
  readonly newQueryPerSession?: boolean;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveEnvironment?: ClaudeAdapterLiveOptions["resolveEnvironment"];
  readonly instanceId?: ProviderInstanceId;
  readonly createQueryError?: Error;
  readonly onAuthStatusChanged?: ClaudeAdapterLiveOptions["onAuthStatusChanged"];
  readonly forkNativeSession?: ClaudeAdapterLiveOptions["forkNativeSession"];
  readonly deleteNativeSession?: ClaudeAdapterLiveOptions["deleteNativeSession"];
  readonly listNativeSubagents?: ClaudeAdapterLiveOptions["listNativeSubagents"];
  readonly getNativeSubagentMessages?: ClaudeAdapterLiveOptions["getNativeSubagentMessages"];
}) {
  const query = new FakeClaudeQuery();
  const queries = [query];
  const createInputs: Array<{
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }> = [];
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    getNativeVersion: () => config?.nativeVersion,
    getSubagentConcurrencySupport: () => config?.subagentConcurrencySupported ?? false,
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    ...(config?.environment ? { environment: config.environment } : {}),
    ...(config?.resolveEnvironment ? { resolveEnvironment: config.resolveEnvironment } : {}),
    createQuery: (input) => {
      createInput = input;
      createInputs.push(input);
      if (config?.createQueryError) throw config.createQueryError;
      if (config?.newQueryPerSession && createInputs.length > 1) {
        const next = new FakeClaudeQuery();
        queries.push(next);
        return next;
      }
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
    ...(config?.onAuthStatusChanged
      ? {
          onAuthStatusChanged: config.onAuthStatusChanged,
        }
      : {}),
    ...(config?.forkNativeSession ? { forkNativeSession: config.forkNativeSession } : {}),
    ...(config?.deleteNativeSession ? { deleteNativeSession: config.deleteNativeSession } : {}),
    ...(config?.listNativeSubagents ? { listNativeSubagents: config.listNativeSubagents } : {}),
    ...(config?.getNativeSubagentMessages
      ? { getNativeSubagentMessages: config.getNativeSubagentMessages }
      : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    queries,
    createInputs,
    getLastCreateQueryInput: () => createInput,
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

async function readPromptMessages(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
  count: number,
): Promise<SDKUserMessage[]> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return [];
  }
  const messages: SDKUserMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    messages.push(next.value);
  }
  return messages;
}

function promptMessageText(message: SDKUserMessage | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if (typeof message.message.content === "string") {
    return message.message.content;
  }
  const content = message.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

function claudeProjectDirectoryForTest(homePath: string, cwd: string): string {
  return path.join(homePath, ".claude", "projects", claudeProjectDirectoryName(path, cwd));
}

const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");

/** A private native transcript with three Cafe prompts and a nonassistant leaf. */
function makeRewindHarness(options?: Pick<ClaudeAdapterLiveOptions, "forkNativeSession">) {
  const homePath = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-rewind-home-")));
  const cwd = path.join(homePath, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  const sessionId = "71000000-0000-4000-8000-000000000001";
  const first = TurnId.make("71000000-0000-4000-8000-000000000002");
  const second = TurnId.make("71000000-0000-4000-8000-000000000003");
  const third = TurnId.make("71000000-0000-4000-8000-000000000004");
  const answer = "71000000-0000-4000-8000-000000000005";
  const retainedAttachment = "71000000-0000-4000-8000-000000000006";
  const toolUse = "71000000-0000-4000-8000-000000000008";
  const toolResult = "71000000-0000-4000-8000-000000000009";
  const steer = "71000000-0000-4000-8000-000000000010";
  const entries: SessionStoreEntry[] = [
    {
      type: "user",
      uuid: first,
      parentUuid: null,
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "first prompt" },
    },
    {
      type: "assistant",
      uuid: answer,
      parentUuid: first,
      sessionId,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    },
    {
      type: "user",
      uuid: second,
      parentUuid: answer,
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "second prompt" },
    },
    {
      type: "assistant",
      uuid: toolUse,
      parentUuid: second,
      sessionId,
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "retained-tool", name: "Read", input: {} }],
      },
    },
    {
      type: "user",
      uuid: toolResult,
      parentUuid: toolUse,
      sessionId,
      isSidechain: false,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "retained-tool", content: "kept tool result" },
        ],
      },
    },
    {
      type: "user",
      uuid: steer,
      parentUuid: toolResult,
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "kept in-turn steer" },
    },
    {
      type: "attachment",
      uuid: retainedAttachment,
      parentUuid: steer,
      sessionId,
      isSidechain: false,
      attachment: { type: "structured_output", data: { answer: "kept structure" } },
    },
    {
      type: "user",
      uuid: third,
      parentUuid: retainedAttachment,
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "third prompt must disappear" },
    },
  ];
  const projectDirectory = claudeProjectDirectoryForTest(homePath, cwd);
  mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(projectDirectory, `${sessionId}.jsonl`);
  const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  writeFileSync(sourcePath, contents, { mode: 0o600 });
  const harness = makeHarness({
    newQueryPerSession: true,
    environment: {},
    cwd,
    claudeConfig: { homePath },
    ...options,
  });
  return {
    ...harness,
    homePath,
    cwd,
    sessionId,
    first,
    second,
    third,
    sourcePath,
    projectDirectory,
    contents,
  };
}

describe("Claude project directory encoding", () => {
  it("matches upstream punctuation replacement and bounded long-path hashing", () => {
    assert.equal(
      encodeClaudeProjectDirectoryName(String.raw`C:\Users\mike\work.dir`),
      "C--Users-mike-work-dir",
    );
    assert.equal(encodeClaudeProjectDirectoryName("a".repeat(201)), `${"a".repeat(200)}-rkvsv5`);
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect(
    "replaces live commands after add/remove/rename and rejects foreign-session pushes without rebinding",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const initialized = yield* Deferred.make<void>();
        const catalogs: unknown[] = [];
        const nativeThreads: string[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            if (event.type === "session.configured" && event.raw?.method === "claude/system/init")
              yield* Deferred.succeed(initialized, undefined);
            if (event.type === "session.configured" && event.payload.commandCatalogChanged) {
              catalogs.push(event);
              assert.deepEqual(event.payload, { config: {}, commandCatalogChanged: true });
            }
            if (event.type === "thread.started" && event.payload.providerThreadId !== undefined)
              nativeThreads.push(event.payload.providerThreadId);
          }),
        ).pipe(Effect.forkScoped);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        harness.query.emit({
          type: "system",
          subtype: "init",
          session_id: "native-commands",
          uuid: "init-commands",
          capabilities: [],
        } as unknown as SDKMessage);
        yield* Deferred.await(initialized);
        const push = (names: string[], session = "native-commands") =>
          harness.query.emit({
            type: "system",
            subtype: "commands_changed",
            session_id: session,
            uuid: "commands-change",
            commands: names.map((name) => ({ name, description: name, argumentHint: "" })),
          } as unknown as SDKMessage);
        push(["first"]);
        push(["first", "second"]);
        push(["renamed"]);
        yield* TestClock.adjust(100);
        assert.deepEqual(
          (yield* adapter.listSessions())[0]?.commandCatalog?.commands.map(
            (command) => command.name,
          ),
          ["renamed"],
        );
        assert.lengthOf(catalogs, 1);
        push(["foreign"], "unrelated-native-session");
        yield* TestClock.adjust(100);
        const afterForeign = (yield* adapter.listSessions())[0];
        assert.deepEqual(
          afterForeign?.commandCatalog?.commands.map((command) => command.name),
          ["renamed"],
        );
        assert.deepEqual(nativeThreads, ["native-commands"]);
        push([]);
        yield* TestClock.adjust(100);
        assert.deepEqual((yield* adapter.listSessions())[0]?.commandCatalog, {
          status: "empty",
          commands: [],
        });
        assert.equal(harness.createInputs.length, 1);
        assert.lengthOf(harness.query.interruptCalls, 0);
        assert.equal(harness.query.closeCalls, 0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("retains repeated pre-init changes and fences a slower initialization catalog", () => {
    const harness = makeHarness();
    let resolveInitial!: (value: unknown) => void;
    harness.query.supportedCommands = () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const initialized = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "session.configured" && event.raw?.method === "claude/system/init"
          ? Deferred.succeed(initialized, undefined)
          : Effect.void,
      ).pipe(Effect.forkScoped);
      for (const name of ["old", "plugin:Current"])
        harness.query.emit({
          type: "system",
          subtype: "commands_changed",
          session_id: "preinit-native",
          uuid: name,
          commands: [{ name, description: "", argumentHint: "" }],
        } as unknown as SDKMessage);
      // Include frames already buffered before the stream fiber is started.
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* TestClock.adjust(100);
      assert.equal((yield* adapter.listSessions())[0]?.commandCatalog?.status, "unavailable");
      harness.query.emit({
        type: "system",
        subtype: "commands_changed",
        session_id: "x".repeat(1025),
        uuid: "oversized-session",
        commands: [{ name: "must-not-replace-pending" }],
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "init",
        session_id: "preinit-native",
        uuid: "init",
        capabilities: [],
      } as unknown as SDKMessage);
      yield* Deferred.await(initialized);
      resolveInitial([{ name: "stale-init", description: "", argumentHint: "" }]);
      yield* TestClock.adjust(100);
      assert.deepEqual(
        (yield* adapter.listSessions())[0]?.commandCatalog?.commands.map((command) => command.name),
        ["plugin:Current"],
      );
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "bounds failing/slow initialization without blocking the session or restoring an old query",
    () => {
      const harness = makeHarness({ newQueryPerSession: true });
      let resolveInitial!: (value: unknown) => void;
      harness.query.supportedCommands = () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        yield* TestClock.adjust(8_100);
        assert.deepEqual((yield* adapter.listSessions())[0]?.commandCatalog, {
          status: "unavailable",
          commands: [],
        });
        yield* adapter.stopSession(THREAD_ID);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        resolveInitial([{ name: "old-query-private-command" }]);
        yield* TestClock.adjust(100);
        assert.deepEqual((yield* adapter.listSessions())[0]?.commandCatalog, {
          status: "unavailable",
          commands: [],
        });
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  for (const toolName of ["WebFetch", "WebSearch", "mcp__test__lookup"]) {
    it.effect(
      `retains detached ${toolName} through response boundaries and settles the original item exactly once`,
      () => {
        const harness = makeHarness({
          nativeVersion: "2.1.287",
          subagentConcurrencySupported: true,
          environment: {},
        });
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const events: ProviderRuntimeEvent[] = [];
          const started = yield* Deferred.make<void>();
          const boundary = yield* Deferred.make<void>();
          const settled = yield* Deferred.make<void>();
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "item.started" && event.itemId === "detached-tool")
                yield* Deferred.succeed(started, undefined);
              if (event.type === "turn.completed") yield* Deferred.succeed(boundary, undefined);
              if (event.type === "item.completed" && event.itemId === "detached-tool")
                yield* Deferred.succeed(settled, undefined);
            }),
          ).pipe(Effect.forkChild);
          yield* adapter.startSession({
            threadId: THREAD_ID,
            runtimeMode: "approval-required",
            maxConcurrentSubagents: 8,
          });
          const first = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "look up" });
          const prompt = yield* Effect.promise(() =>
            readFirstPromptMessage(harness.getLastCreateQueryInput()),
          );
          harness.query.emit({
            type: "stream_event",
            session_id: "synthetic",
            parent_tool_use_id: null,
            uuid: "tool-start",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "detached-tool",
                name: toolName,
                input: { query: "safe" },
              },
            },
          } as unknown as SDKMessage);
          yield* Deferred.await(started);
          if (toolName !== "WebFetch") {
            harness.query.emit({
              type: "system",
              subtype: "task_started",
              task_id: "native-detached",
              tool_use_id: "detached-tool",
              task_type: "local_bash",
              description: "Detached lookup",
              session_id: "synthetic",
              uuid: "00000000-0000-4000-8000-000000000010",
            } as SDKMessage);
          }
          harness.query.emit({
            type: "user",
            session_id: "synthetic",
            parent_tool_use_id: null,
            uuid: "detached-placeholder",
            tool_use_result: { detachedToolCall: true },
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "detached-tool", content: "Still running" },
              ],
            },
          } as unknown as SDKMessage);
          harness.query.emit({
            ...makeSuccessfulClaudeResult("synthetic"),
            user_message_uuid: prompt?.uuid,
          } as SDKMessage);
          yield* Deferred.await(boundary);
          assert.equal(
            events.filter(
              (event) => event.type === "item.completed" && event.itemId === "detached-tool",
            ).length,
            0,
          );
          assert.equal(
            (yield* adapter
              .startSession({
                threadId: THREAD_ID,
                runtimeMode: "approval-required",
                maxConcurrentSubagents: 4,
                requireIdleForSubagentLimitChange: true,
              })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal(harness.query.closeCalls, 0);
          assert.equal(harness.query.waitForExitCalls, 0);
          yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next response" });
          // A new response reuses stream index zero but must not replace the old
          // tool identity or attach its eventual output to this new Cafe turn.
          harness.query.emit({
            type: "stream_event",
            session_id: "synthetic",
            parent_tool_use_id: null,
            uuid: "new-tool-start",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "new-tool", name: "Read", input: {} },
            },
          } as unknown as SDKMessage);
          const late =
            toolName === "WebSearch"
              ? ({
                  type: "system",
                  subtype: "task_notification",
                  task_id: "native-detached",
                  tool_use_id: "detached-tool",
                  status: "completed",
                  summary: "Actual output",
                  output_file: "",
                  session_id: "synthetic",
                  uuid: "00000000-0000-4000-8000-000000000011",
                } as SDKMessage)
              : toolName === "mcp__test__lookup"
                ? ({
                    type: "system",
                    subtype: "task_updated",
                    task_id: "native-detached",
                    patch: {
                      status: "completed",
                      tool_use_id: "detached-tool",
                      summary: "Actual output",
                    },
                    session_id: "synthetic",
                    uuid: "00000000-0000-4000-8000-000000000012",
                  } as unknown as SDKMessage)
                : ({
                    type: "user",
                    session_id: "synthetic",
                    parent_tool_use_id: null,
                    uuid: "late-result",
                    message: {
                      role: "user",
                      content: [
                        {
                          type: "tool_result",
                          tool_use_id: "detached-tool",
                          content: "Actual output",
                        },
                      ],
                    },
                  } as unknown as SDKMessage);
          harness.query.emit(late);
          yield* Deferred.await(settled);
          harness.query.emit(late);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          const completions = events.filter(
            (event) => event.type === "item.completed" && event.itemId === "detached-tool",
          );
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.turnId, first.turnId);
          assert.equal(
            events.some((event) => event.type === "item.completed" && event.itemId === "new-tool"),
            false,
          );
          assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }
  for (const priority of [undefined, "now", "next", "later"] as const) {
    it.effect(
      `preserves explicit Claude ${priority ?? "default"} delivery and human UUID correlation`,
      () => {
        const harness = makeHarness({ nativeVersion: "2.1.287", environment: {} });
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
          const turn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "first",
            ...(priority ? { deliveryPriority: priority } : {}),
          });
          const executing = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "item.started"),
            Stream.runHead,
            Effect.forkChild,
          );
          harness.query.emit({
            type: "stream_event",
            session_id: "synthetic",
            parent_tool_use_id: null,
            uuid: "tool-start",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "busy-tool", name: "WebSearch", input: {} },
            },
          } as unknown as SDKMessage);
          yield* Fiber.join(executing);
          yield* adapter.steerTurn({
            threadId: THREAD_ID,
            expectedTurnId: turn.turnId,
            input: "follow up",
            ...(priority ? { deliveryPriority: priority } : {}),
          });
          const messages = yield* Effect.promise(() =>
            readPromptMessages(harness.getLastCreateQueryInput(), 2),
          );
          assert.equal(messages[0]?.priority, priority);
          assert.equal(messages[1]?.priority, priority);
          assert.deepEqual(messages[0]?.origin, { kind: "human" });
          assert.notEqual(messages[0]?.uuid, messages[1]?.uuid);
          assert.deepEqual(harness.query.interruptCalls, []);
          assert.equal(harness.createInputs[0]?.options.perTaskStopAffordance, undefined);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }
  it.effect(
    "rejects unqualified or scheduled priorities before queue admission and preserves synthetic provenance",
    () => {
      const harness = makeHarness({ environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
        for (const input of [
          { deliveryPriority: "now" as const },
          { deliveryPriority: "later" as const, inputOrigin: "scheduled" as const },
        ]) {
          assert.equal(
            (yield* adapter
              .sendTurn({ threadId: THREAD_ID, input: "denied", ...input })
              .pipe(Effect.result))._tag,
            "Failure",
          );
        }
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "scheduled",
          inputOrigin: "scheduled",
        });
        const message = yield* Effect.promise(() =>
          readFirstPromptMessage(harness.getLastCreateQueryInput()),
        );
        assert.equal(message?.priority, undefined);
        assert.equal(message?.origin, undefined);
        assert.equal(message?.isSynthetic, true);
        assert.equal(harness.query.setModelCalls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "binds task stop/background to exact chat account generation and task incarnation without completing siblings",
    () => {
      const harness = makeHarness({ nativeVersion: "2.1.287", environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
        });
        const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "work" });
        const observed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.started"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "native-task",
          tool_use_id: "distinct-tool",
          task_type: "local_agent",
          description: "Worker",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000001",
        } as SDKMessage);
        const event = yield* Fiber.join(observed);
        assert.equal(event._tag, "Some");
        if (event._tag !== "Some" || event.value.type !== "task.started")
          throw new Error("Expected task start");
        const capability = event.value.payload.subagent?.taskControl;
        assert.ok(capability);
        assert.ok(session.subagentRuntimeId);
        const input = {
          threadId: THREAD_ID,
          turnId: turn.turnId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeId: session.subagentRuntimeId!,
          taskId: "native-task",
          taskGeneration: capability!.taskGeneration,
          action: "stop" as const,
        };
        for (const forged of [
          { ...input, taskGeneration: "00000000-0000-4000-8000-000000000000" },
          { ...input, providerInstanceId: ProviderInstanceId.make("different-account") },
          { ...input, turnId: TurnId.make("different-turn") },
          { ...input, taskId: "distinct-tool" },
        ]) {
          assert.equal((yield* adapter.controlTask!(forged).pipe(Effect.result))._tag, "Failure");
        }
        assert.deepEqual(harness.query.stopTaskCalls, []);
        assert.deepEqual(yield* adapter.controlTask!({ ...input, action: "background" }), {
          status: "accepted",
        });
        assert.deepEqual(harness.query.backgroundTaskCalls, ["distinct-tool"]);
        assert.deepEqual(yield* adapter.controlTask!(input), { status: "accepted" });
        assert.deepEqual(harness.query.stopTaskCalls, ["native-task"]);
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
        assert.deepEqual(harness.query.interruptCalls, []);
        const ended = yield* adapter.streamEvents.pipe(
          Stream.filter((value) => value.type === "task.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "native-task",
          tool_use_id: "distinct-tool",
          status: "stopped",
          summary: "Stopped",
          output_file: "",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000002",
        } as SDKMessage);
        yield* Fiber.join(ended);
        assert.deepEqual(yield* adapter.controlTask!(input), { status: "already-terminal" });
        assert.deepEqual(harness.query.stopTaskCalls, ["native-task"]);
        const restarted = yield* adapter.streamEvents.pipe(
          Stream.filter((value) => value.type === "task.started"),
          Stream.runHead,
          Effect.forkChild,
        );
        // This task-id reuse deliberately omits a tool id. No old alias may
        // supply background authority for the new incarnation.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "native-task",
          task_type: "local_agent",
          description: "New worker",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000003",
        } as SDKMessage);
        const newStart = yield* Fiber.join(restarted);
        assert.equal(newStart._tag, "Some");
        if (newStart._tag !== "Some" || newStart.value.type !== "task.started")
          throw new Error("Expected restarted task");
        assert.notEqual(
          newStart.value.payload.subagent?.taskControl?.taskGeneration,
          input.taskGeneration,
        );
        assert.equal(newStart.value.payload.subagent?.taskControl?.canBackground, false);
        assert.equal((yield* adapter.controlTask!(input).pipe(Effect.result))._tag, "Failure");
        const staleIgnored = yield* adapter.streamEvents.pipe(
          Stream.filter((value) => value.type === "runtime.warning"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "native-task",
          tool_use_id: "distinct-tool",
          status: "stopped",
          ambient: true,
          summary: "Old worker stopped",
          output_file: "",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000004",
        } as SDKMessage);
        yield* Fiber.join(staleIgnored);
        const omittedIgnored = yield* adapter.streamEvents.pipe(
          Stream.filter((value) => value.type === "runtime.warning"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "native-task",
          patch: { status: "completed" },
          session_id: "synthetic",
          uuid: "late-unqualified-update",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "native-task",
          status: "completed",
          summary: "Ambiguous old worker",
          output_file: "",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000014",
        } as SDKMessage);
        yield* Fiber.join(omittedIgnored);
        assert.deepEqual(
          yield* adapter.controlTask!({
            ...input,
            taskGeneration: newStart.value.payload.subagent!.taskControl!.taskGeneration,
          }),
          { status: "accepted" },
        );
        assert.deepEqual(harness.query.stopTaskCalls, ["native-task", "native-task"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  for (const priority of [undefined, "now", "next", "later"] as const) {
    it.effect(
      `preserves ${priority ?? "default"} delivery while an exact tool approval remains pending`,
      () => {
        const harness = makeHarness({ nativeVersion: "2.1.287", environment: {} });
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
          const first = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
          const opened = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "request.opened"),
            Stream.runHead,
            Effect.forkChild,
          );
          let permissionSettled = false;
          const permission = harness.getLastCreateQueryInput()!.options.canUseTool!(
            "Bash",
            { command: "pwd" },
            {
              signal: new AbortController().signal,
              toolUseID: "pending-tool",
              requestId: "pending-approval",
            },
          ).then((result) => {
            permissionSettled = true;
            return result;
          });
          const approval = yield* Fiber.join(opened);
          assert.ok(
            approval._tag === "Some" &&
              approval.value.type === "request.opened" &&
              approval.value.requestId,
          );
          yield* adapter.steerTurn({
            threadId: THREAD_ID,
            expectedTurnId: first.turnId,
            input: "during approval",
            ...(priority ? { deliveryPriority: priority } : {}),
          });
          const prompts = yield* Effect.promise(() =>
            readPromptMessages(harness.getLastCreateQueryInput(), 2),
          );
          assert.equal(prompts[1]?.priority, priority);
          assert.equal(new Set(prompts.map((message) => message.uuid)).size, 2);
          assert.equal(permissionSettled, false);
          assert.deepEqual(harness.query.interruptCalls, []);
          if (approval._tag === "Some" && approval.value.requestId) {
            yield* adapter.respondToRequest(
              THREAD_ID,
              ApprovalRequestId.make(approval.value.requestId),
              "decline",
            );
          }
          assert.equal((yield* Effect.promise(() => permission))?.behavior, "deny");
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }
  it.effect(
    "publishes background-only controls for ordinary foreground tools and stop controls for exact native non-agent tasks",
    () => {
      const harness = makeHarness({ nativeVersion: "2.1.287", environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
        });
        const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "fetch" });
        const item = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "item.started"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "stream_event",
          session_id: "synthetic",
          parent_tool_use_id: null,
          uuid: "tool-start",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "raw-fetch", name: "WebFetch", input: {} },
          },
        } as unknown as SDKMessage);
        const itemEvent = yield* Fiber.join(item);
        if (itemEvent._tag !== "Some" || itemEvent.value.type !== "item.started")
          throw new Error("Missing foreground item");
        const reference = itemEvent.value.payload.individualTaskControl!;
        assert.ok(reference);
        assert.equal(reference.capability.canStop, false);
        assert.equal(reference.capability.canBackground, true);
        assert.notEqual(reference.taskId, "raw-fetch");
        const input = {
          threadId: THREAD_ID,
          turnId: turn.turnId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeId: session.subagentRuntimeId!,
          taskId: reference.taskId,
          taskGeneration: reference.capability.taskGeneration,
        };
        assert.equal(
          (yield* adapter.controlTask!({ ...input, action: "stop" }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepEqual(yield* adapter.controlTask!({ ...input, action: "background" }), {
          status: "accepted",
        });
        assert.deepEqual(harness.query.backgroundTaskCalls, ["raw-fetch"]);
        const task = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.started"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "native-fetch",
          tool_use_id: "raw-fetch",
          task_type: "local_bash",
          is_backgrounded: true,
          description: "Fetch running",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000005",
        } as unknown as SDKMessage);
        const taskEvent = yield* Fiber.join(task);
        if (taskEvent._tag !== "Some" || taskEvent.value.type !== "task.started")
          throw new Error("Missing native task");
        assert.equal(taskEvent.value.payload.subagent, undefined);
        const native = taskEvent.value.payload.individualTaskControl!;
        assert.ok(native.capability.canStop);
        assert.equal(native.capability.canBackground, false);
        assert.deepEqual(yield* adapter.controlTask!({ ...input, action: "background" }), {
          status: "not-foreground",
        });
        assert.deepEqual(harness.query.backgroundTaskCalls, ["raw-fetch"]);
        assert.deepEqual(
          yield* adapter.controlTask!({
            ...input,
            taskId: native.taskId,
            taskGeneration: native.capability.taskGeneration,
            action: "stop",
          }),
          { status: "accepted" },
        );
        assert.deepEqual(harness.query.stopTaskCalls, ["native-fetch"]);
        assert.deepEqual(harness.query.interruptCalls, []);
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "keeps ordinary task liveness uncertain after unresolved binding eviction even when every retained task ends",
    () => {
      const harness = makeHarness({ subagentConcurrencySupported: true, environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 8,
        });
        const done = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "task.completed" && event.payload.taskId === "native-4096"
              ? Deferred.succeed(done, undefined)
              : Effect.void,
          ),
          Effect.forkChild,
        );
        for (let index = 0; index < 4097; index++)
          harness.query.emit({
            type: "system",
            subtype: "task_started",
            task_id: `native-${index}`,
            task_type: "local_bash",
            description: "Ordinary task",
            session_id: "synthetic",
            uuid: "00000000-0000-4000-8000-000000000020",
          } as SDKMessage);
        for (let index = 1; index < 4097; index++)
          harness.query.emit({
            type: "system",
            subtype: "task_notification",
            task_id: `native-${index}`,
            status: "completed",
            summary: "Done",
            output_file: "",
            session_id: "synthetic",
            uuid: "00000000-0000-4000-8000-000000000021",
          } as SDKMessage);
        yield* Deferred.await(done);
        assert.equal(
          (yield* adapter
            .startSession({
              threadId: THREAD_ID,
              runtimeMode: "full-access",
              maxConcurrentSubagents: 4,
              requireIdleForSubagentLimitChange: true,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(harness.query.waitForExitCalls, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  for (const configuredInstance of [undefined, ProviderInstanceId.make("claude-work-account")]) {
    it.effect(
      `injects same-chat scheduling for ${configuredInstance ?? "the default account"}`,
      () => {
        const harness = makeHarness({
          environment: {},
          ...(configuredInstance ? { instanceId: configuredInstance } : {}),
        });
        return Effect.gen(function* () {
          const lifecycle: string[] = [];
          const releaseBroker = installSchedulingSessionBroker({
            bind: async (binding) => {
              assert.deepEqual(binding, {
                threadId: THREAD_ID,
                providerInstanceId: configuredInstance ?? ProviderInstanceId.make("claudeAgent"),
                provider: "claudeAgent",
              });
              lifecycle.push("bound");
              let disposed = false;
              return {
                name: "cafe-scheduling",
                launch: {
                  command: process.execPath,
                  args: [path.join(process.cwd(), "synthetic-scheduling-bridge.mjs")],
                  env: { CAFE_CODE_SCHEDULING_CONNECTION_FILE: "synthetic-private-connection" },
                },
                activate: async () => {
                  lifecycle.push("active");
                },
                dispose: async () => {
                  if (!disposed) lifecycle.push("disposed");
                  disposed = true;
                },
              };
            },
          });
          yield* Effect.addFinalizer(() => Effect.sync(releaseBroker));
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
          const queryOptions = harness.createInputs[0]!.options;
          assert.deepEqual(lifecycle, ["bound", "active"]);
          assert.deepEqual(queryOptions.mcpServers, {
            "cafe-scheduling": {
              type: "stdio",
              command: process.execPath,
              args: [path.join(process.cwd(), "synthetic-scheduling-bridge.mjs")],
              env: { CAFE_CODE_SCHEDULING_CONNECTION_FILE: "synthetic-private-connection" },
              alwaysLoad: true,
            },
          });
          assert.deepEqual(queryOptions.settingSources, ["user", "project", "local"]);
          assert.equal(queryOptions.strictMcpConfig, undefined);
          assert.equal(queryOptions.allowedTools, undefined);
          assert.equal(queryOptions.permissionMode, "default");
          assert.equal(queryOptions.allowDangerouslySkipPermissions, undefined);
          yield* adapter.stopSession(THREAD_ID);
          yield* adapter.stopAll();
          assert.deepEqual(lifecycle, ["bound", "active", "disposed"]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  it.effect("revokes scheduling when Claude query creation fails", () => {
    const harness = makeHarness({
      environment: {},
      createQueryError: new Error("synthetic failure"),
    });
    return Effect.gen(function* () {
      let disposed = false;
      const releaseBroker = installSchedulingSessionBroker({
        bind: async () => ({
          name: "cafe-scheduling",
          launch: { command: process.execPath, args: [], env: {} },
          activate: async () => {},
          dispose: async () => {
            disposed = true;
          },
        }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(releaseBroker));
      const adapter = yield* ClaudeAdapter;
      const failed = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");
      assert.isTrue(disposed);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("revokes scheduling without launching Claude after activation failure", () => {
    const harness = makeHarness({ environment: {} });
    return Effect.gen(function* () {
      let disposed = false;
      const releaseBroker = installSchedulingSessionBroker({
        bind: async () => ({
          name: "cafe-scheduling",
          launch: { command: process.execPath, args: [], env: {} },
          activate: async () => {
            throw new Error("private activation diagnostic");
          },
          dispose: async () => {
            disposed = true;
          },
        }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(releaseBroker));
      const adapter = yield* ClaudeAdapter;
      const failure = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterProcessError");
      assert.notInclude(JSON.stringify(failure), "private activation diagnostic");
      assert.equal(harness.createInputs.length, 0);
      assert.isTrue(disposed);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("still closes Claude if revoked scheduling file cleanup fails", () => {
    const harness = makeHarness({ environment: {} });
    return Effect.gen(function* () {
      let revoked = false;
      const releaseBroker = installSchedulingSessionBroker({
        bind: async () => ({
          name: "cafe-scheduling",
          launch: { command: process.execPath, args: [], env: {} },
          activate: async () => {},
          dispose: async () => {
            revoked = true;
            throw new Error("private cleanup diagnostic");
          },
        }),
      });
      yield* Effect.addFinalizer(() => Effect.sync(releaseBroker));
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
      yield* adapter.stopSession(THREAD_ID);
      assert.isTrue(revoked);
      assert.equal(harness.query.closeCalls, 1);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "retires each Claude scheduling generation before replacement and on stream exit",
    () => {
      const harness = makeHarness({ environment: {}, newQueryPerSession: true });
      return Effect.gen(function* () {
        const lifecycle: string[] = [];
        let generation = 0;
        const releaseBroker = installSchedulingSessionBroker({
          bind: async () => {
            const id = ++generation;
            lifecycle.push(`bind:${id}`);
            let disposed = false;
            return {
              name: "cafe-scheduling",
              launch: { command: process.execPath, args: [], env: {} },
              activate: async () => {
                lifecycle.push(`activate:${id}`);
              },
              dispose: async () => {
                if (!disposed) lifecycle.push(`dispose:${id}`);
                disposed = true;
              },
            };
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(releaseBroker));
        const adapter = yield* ClaudeAdapter;
        const start = { threadId: THREAD_ID, runtimeMode: "approval-required" as const };
        yield* adapter.startSession(start);
        yield* adapter.startSession(start);
        assert.deepEqual(lifecycle, ["bind:1", "activate:1", "dispose:1", "bind:2", "activate:2"]);
        const exited = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "session.exited"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.queries[1]!.finish();
        yield* Fiber.join(exited);
        assert.deepEqual(lifecycle, [
          "bind:1",
          "activate:1",
          "dispose:1",
          "bind:2",
          "activate:2",
          "dispose:2",
        ]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  for (const retainHistory of [false, true]) {
    it.effect(
      `handles a compacted-away checkpoint with ${retainHistory ? "explicit partial-rewind refusal" : "an empty baseline"}`,
      () => {
        const harness = makeRewindHarness();
        const compactBoundary = "71000000-0000-4000-8000-000000000011";
        const contents =
          [
            {
              type: "system",
              subtype: "compact_boundary",
              uuid: compactBoundary,
              parentUuid: null,
              sessionId: harness.sessionId,
              isSidechain: false,
              compactMetadata: { trigger: "auto", preTokens: 100 },
            },
            {
              type: "user",
              uuid: harness.third,
              parentUuid: compactBoundary,
              sessionId: harness.sessionId,
              isSidechain: false,
              message: { role: "user", content: "current compacted conversation" },
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
        writeFileSync(harness.sourcePath, contents);
        return Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
          );
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            runtimeMode: "approval-required",
            cwd: harness.cwd,
            resumeCursor: { resume: harness.sessionId, turnCount: 3 },
          });
          if (retainHistory) {
            const outcome = yield* adapter.prepareRollbackThread!(THREAD_ID, 2, {
              firstRemovedTurnId: harness.second,
              retainedTurnCount: 1,
            }).pipe(Effect.exit);
            assert.equal(outcome._tag, "Failure");
            assert.equal(harness.query.closeCalls, 0);
          } else {
            const candidate = yield* adapter.prepareRollbackThread!(THREAD_ID, 3, {
              firstRemovedTurnId: harness.first,
              retainedTurnCount: 0,
            });
            assert.equal(candidate.status, "closed");
            assert.isUndefined(candidate.resumeCursor);
          }
          assert.equal(readFileSync(harness.sourcePath, "utf8"), contents);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  it.effect(
    "prepares a closed exact native prefix and uses stable prompt lineage after restart",
    () => {
      const harness = makeRewindHarness();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: { resume: harness.sessionId, turnCount: 3 },
        });
        const candidate = yield* adapter.prepareRollbackThread!(THREAD_ID, 1, {
          firstRemovedTurnId: harness.third,
          retainedTurnCount: 2,
        });
        assert.equal(candidate.status, "closed");
        assert.equal(
          harness.createInputs.length,
          1,
          "preparation cannot launch a replacement query",
        );
        assert.equal(harness.query.waitForExitCalls, 1);
        assert.equal(readFileSync(harness.sourcePath, "utf8"), harness.contents);
        const cursor = candidate.resumeCursor as {
          resume: string;
          turnCount: number;
          rewindMessageIds: Record<string, string>;
        };
        assert.notEqual(cursor.resume, harness.sessionId);
        const retained = readFileSync(
          path.join(harness.projectDirectory, `${cursor.resume}.jsonl`),
          "utf8",
        );
        assert.include(retained, "kept structure");
        assert.include(retained, "kept in-turn steer");
        assert.include(retained, "kept tool result");
        assert.notInclude(retained, "third prompt must disappear");
        assert.isDefined(cursor.rewindMessageIds[harness.first]);
        assert.isDefined(cursor.rewindMessageIds[harness.second]);
        assert.isUndefined(cursor.rewindMessageIds[harness.third]);

        // This new runtime has no in-memory turn array: the committed cursor is
        // sufficient to bind an older original Cafe UUID through the SDK remap.
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: candidate.resumeCursor,
        });
        const older = yield* adapter.prepareRollbackThread!(THREAD_ID, 1, {
          firstRemovedTurnId: harness.second,
          retainedTurnCount: 1,
        });
        const olderCursor = older.resumeCursor as {
          resume: string;
          rewindMessageIds: Record<string, string>;
        };
        const olderHistory = readFileSync(
          path.join(harness.projectDirectory, `${olderCursor.resume}.jsonl`),
          "utf8",
        );
        assert.include(olderHistory, "first answer");
        assert.notInclude(olderHistory, "second prompt");
        assert.notEqual(
          olderCursor.rewindMessageIds[harness.first],
          cursor.rewindMessageIds[harness.first],
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: older.resumeCursor,
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next prompt", attachments: [] });
        const resumed = harness.getLastCreateQueryInput()!;
        assert.equal(resumed.options.resume, olderCursor.resume);
        assert.isUndefined(resumed.options.resumeSessionAt);
        assert.equal(yield* Effect.promise(() => readFirstPromptText(resumed)), "next prompt");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "keeps the retired generation fenced when the SDK refuses before candidate publication",
    () => {
      const harness = makeRewindHarness({
        forkNativeSession: async () => {
          throw new Error("Synthetic prepublication refusal");
        },
      });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: { resume: harness.sessionId, turnCount: 3 },
        });
        const outcome = yield* adapter.prepareRollbackThread!(THREAD_ID, 1, {
          firstRemovedTurnId: harness.third,
          retainedTurnCount: 2,
        }).pipe(Effect.flip);
        assert.equal(outcome._tag, "ProviderAdapterRewindOutcomeUnknownError");
        assert.equal(harness.query.waitForExitCalls, 1);
        assert.equal(harness.createInputs.length, 1);
        assert.equal(readFileSync(harness.sourcePath, "utf8"), harness.contents);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "rejects a path-shaped live session ID before reading or retiring a baseline rewind",
    () => {
      const harness = makeRewindHarness();
      const maliciousSessionId = "../outside-session";
      // Keep the adversarial target inside this private temporary fixture, but
      // outside the exact project directory. A missing/invalid file would make
      // the old vulnerable path refuse for an unrelated reason and hide the
      // missing live-SDK identity admission check.
      const outsidePath = path.resolve(harness.projectDirectory, `${maliciousSessionId}.jsonl`);
      assert.equal(path.dirname(outsidePath), path.dirname(harness.projectDirectory));
      writeFileSync(outsidePath, harness.contents, { mode: 0o600 });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: { resume: harness.sessionId, turnCount: 3 },
        });
        const observed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "session.state.changed"),
          Stream.runHead,
          Effect.forkChild,
        );
        // Persisted cursors are UUID-checked separately. Reproduce the live
        // SDK path instead: its session_id may replace the in-memory identity.
        harness.query.emit({
          type: "system",
          subtype: "status",
          status: null,
          uuid: "71000000-0000-4000-8000-000000000012",
          session_id: maliciousSessionId,
        });
        yield* Fiber.join(observed);
        const sessions = yield* adapter.listSessions();
        assert.equal(
          (sessions[0]?.resumeCursor as { resume?: string } | undefined)?.resume,
          maliciousSessionId,
        );
        const result = yield* adapter.prepareRollbackThread!(THREAD_ID, 3, {
          firstRemovedTurnId: harness.first,
          retainedTurnCount: 0,
        }).pipe(Effect.flip);
        assert.instanceOf(result, ProviderAdapterValidationError);
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(harness.query.waitForExitCalls, 0);
        assert.equal(harness.createInputs.length, 1);
        assert.isTrue(yield* adapter.hasSession(THREAD_ID));
        assert.equal(readFileSync(outsidePath, "utf8"), harness.contents);
        assert.equal(readFileSync(harness.sourcePath, "utf8"), harness.contents);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "prepares an empty baseline without inventing a native session or launching inference",
    () => {
      const harness = makeRewindHarness();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: { resume: harness.sessionId, turnCount: 3 },
        });
        const candidate = yield* adapter.prepareRollbackThread!(THREAD_ID, 3, {
          firstRemovedTurnId: harness.first,
          retainedTurnCount: 0,
        });
        assert.isUndefined(candidate.resumeCursor);
        assert.equal(candidate.status, "closed");
        assert.equal(harness.createInputs.length, 1);
        assert.equal(readFileSync(harness.sourcePath, "utf8"), harness.contents);
        // Only the next explicit user turn creates a fresh query. Clearing the
        // committed cursor must not recover the discarded native history or
        // broaden the user's original approval-required permission mode.
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: candidate.resumeCursor,
        });
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "fresh baseline input",
          attachments: [],
        });
        const fresh = harness.getLastCreateQueryInput()!;
        assert.isUndefined(fresh.options.resume);
        assert.isUndefined(fresh.options.resumeSessionAt);
        assert.equal(fresh.options.permissionMode, "default");
        assert.notEqual(fresh.options.allowDangerouslySkipPermissions, true);
        assert.equal(
          yield* Effect.promise(() => readFirstPromptText(fresh)),
          "fresh baseline input",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "refuses an unverifiable historical checkpoint before retiring the original query",
    () => {
      const harness = makeRewindHarness();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: { resume: harness.sessionId, turnCount: 3 },
        });
        const result = yield* adapter.prepareRollbackThread!(THREAD_ID, 1, {
          firstRemovedTurnId: TurnId.make("legacy-unbound-turn"),
          retainedTurnCount: 2,
        }).pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(readFileSync(harness.sourcePath, "utf8"), harness.contents);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  for (const scenario of ["unverified exit", "late transcript append"] as const) {
    it.effect(`retains a fenced original cursor after ${scenario}`, () => {
      const harness = makeRewindHarness();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        const originalCursor = { resume: harness.sessionId, turnCount: 3 };
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          cwd: harness.cwd,
          resumeCursor: originalCursor,
        });
        if (scenario === "unverified exit")
          harness.query.exitFailure = new Error("Synthetic unconfirmed process exit");
        else
          harness.query.beforeExit = () =>
            writeFileSync(
              harness.sourcePath,
              `${harness.contents}{"type":"summary","summary":"late task"}\n`,
            );
        const result = yield* adapter.prepareRollbackThread!(THREAD_ID, 1, {
          firstRemovedTurnId: harness.third,
          retainedTurnCount: 2,
        }).pipe(Effect.flip);
        assert.equal(result._tag, "ProviderAdapterRewindOutcomeUnknownError");
        const restart = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            runtimeMode: "approval-required",
            cwd: harness.cwd,
            resumeCursor: originalCursor,
          })
          .pipe(Effect.exit);
        assert.equal(restart._tag, "Failure");
        assert.equal(harness.createInputs.length, 1);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("refuses checkpoint preparation while a background descendant is live", () => {
    const harness = makeRewindHarness();
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(harness.homePath, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        runtimeMode: "approval-required",
        cwd: harness.cwd,
        resumeCursor: { resume: harness.sessionId, turnCount: 3 },
      });
      const observed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.started"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        session_id: harness.sessionId,
        uuid: "71000000-0000-4000-8000-000000000007",
        task_id: "background-worker",
        tool_use_id: "agent-tool",
        task_type: "local_agent",
        description: "Background worker",
      } as SDKMessage);
      yield* Fiber.join(observed);
      const result = yield* adapter.prepareRollbackThread!(THREAD_ID, 1, {
        firstRemovedTurnId: harness.third,
        retainedTurnCount: 2,
      }).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect(
    "binds child and session events to one query generation and replaces it only with a new query",
    () => {
      const harness = makeHarness({ newQueryPerSession: true, environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events: ProviderRuntimeEvent[] = [];
        const firstChildSeen = yield* Deferred.make<void>();
        const secondChildSeen = yield* Deferred.make<void>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "task.started") {
              if (event.payload.subagent?.label === "Original worker")
                yield* Deferred.succeed(firstChildSeen, undefined);
              if (event.payload.subagent?.label === "Replacement worker")
                yield* Deferred.succeed(secondChildSeen, undefined);
            }
          }),
        ).pipe(Effect.forkChild);
        const original = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
        });
        assert.match(
          original.subagentRuntimeId!,
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
        );
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Synthetic prompt",
          attachments: [],
        });
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "same-child",
          tool_use_id: "original-tool",
          description: "Original worker",
          task_type: "local_agent",
          session_id: "same-native-history",
          uuid: "original-child-start",
        } as unknown as SDKMessage);
        yield* Deferred.await(firstChildSeen);
        assert.equal(
          (yield* adapter.listSessions())[0]?.subagentRuntimeId,
          original.subagentRuntimeId,
        );
        yield* adapter.stopSession(THREAD_ID);
        const replacement = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
        });
        assert.notEqual(replacement.subagentRuntimeId, original.subagentRuntimeId);
        harness.queries[1]!.emit({
          type: "system",
          subtype: "task_started",
          task_id: "same-child",
          tool_use_id: "replacement-tool",
          description: "Replacement worker",
          task_type: "local_agent",
          session_id: "same-native-history",
          uuid: "replacement-child-start",
        } as unknown as SDKMessage);
        yield* Deferred.await(secondChildSeen);
        const childEvents = events.filter((event) => event.type === "task.started");
        assert.deepEqual(
          childEvents.map((event) => event.subagentRuntimeId),
          [original.subagentRuntimeId, replacement.subagentRuntimeId],
        );
        for (const event of childEvents)
          assert.equal(event.payload.subagent?.runtimeId, event.subagentRuntimeId);
        const exit = events.find((event) => event.type === "session.exited");
        assert.equal(exit?.subagentRuntimeId, original.subagentRuntimeId);
        assert.deepEqual(
          events
            .filter((event) => event.type === "session.started")
            .map((event) => event.subagentRuntimeId),
          [original.subagentRuntimeId, replacement.subagentRuntimeId],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "uses the selected login environment while retaining per-query concurrency snapshots",
    () => {
      const selectedConfigDirectory = path.resolve(os.homedir(), ".claude");
      const selectedEnvironment = Object.freeze({
        CLAUDE_CONFIG_DIR: selectedConfigDirectory,
        CAFE_TEST_LOGIN_SELECTION: "existing-cafe-login",
      });
      let resolutions = 0;
      const harness = makeHarness({
        newQueryPerSession: true,
        environment: { CAFE_TEST_LOGIN_SELECTION: "unresolved-base" },
        resolveEnvironment: Effect.sync(() => {
          resolutions++;
          return selectedEnvironment;
        }),
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        assert.equal(resolutions, 0);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 1,
        });
        const first = harness.createInputs[0]?.options.env;
        yield* adapter.startSession({
          threadId: ThreadId.make("claude-selected-login-sibling"),
          runtimeMode: "full-access",
          maxConcurrentSubagents: 64,
        });
        assert.equal(resolutions, 2);
        for (const input of harness.createInputs) {
          assert.equal(input.options.env?.CLAUDE_CONFIG_DIR, selectedConfigDirectory);
          assert.equal(input.options.env?.CAFE_TEST_LOGIN_SELECTION, "existing-cafe-login");
        }
        assert.equal(first?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "1");
        assert.equal(
          harness.createInputs[1]?.options.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,
          "64",
        );
        assert.notEqual(first, harness.createInputs[1]?.options.env);
        assert.deepEqual(selectedEnvironment, {
          CLAUDE_CONFIG_DIR: selectedConfigDirectory,
          CAFE_TEST_LOGIN_SELECTION: "existing-cafe-login",
        });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "isolates per-chat Claude concurrency environments and snapshots inherited/reset overrides",
    () => {
      const baseEnvironment = Object.freeze({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "128" });
      const harness = makeHarness({
        newQueryPerSession: true,
        environment: baseEnvironment,
        claudeConfig: { maxConcurrentSubagents: 20 },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const first = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 1,
        });
        const firstEnvironment = harness.createInputs[0]?.options.env;
        const second = yield* adapter.startSession({
          threadId: ThreadId.make("claude-limit-sibling"),
          runtimeMode: "full-access",
          maxConcurrentSubagents: 64,
        });
        const inherited = yield* adapter.startSession({
          threadId: ThreadId.make("claude-limit-inherited"),
          runtimeMode: "full-access",
          maxConcurrentSubagents: null,
        });
        assert.equal(first.maxConcurrentSubagents, 1);
        assert.equal(second.maxConcurrentSubagents, 64);
        assert.equal(inherited.maxConcurrentSubagents, 20);
        assert.deepEqual(
          harness.createInputs.map(
            (input) => input.options.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,
          ),
          ["1", "64", "20"],
        );
        assert.equal(firstEnvironment?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "1");
        assert.notEqual(firstEnvironment, harness.createInputs[1]?.options.env);
        assert.equal(baseEnvironment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "128");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "guarded idle Claude restart preserves resume selection and delegates native defaults on reset",
    () => {
      const harness = makeHarness({
        subagentConcurrencySupported: true,
        newQueryPerSession: true,
        environment: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "32" },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 8,
        });
        const reset = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: null,
          requireIdleForSubagentLimitChange: true,
        });
        assert.equal(reset.maxConcurrentSubagents, null);
        assert.equal(harness.query.closeCalls, 1);
        assert.equal(
          harness.createInputs[1]?.options.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,
          "32",
        );
        assert.equal(
          harness.createInputs[0]?.options.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,
          "8",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "rejects guarded active Claude replacement and malformed limits before process teardown",
    () => {
      const harness = makeHarness({ subagentConcurrencySupported: true, environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 8,
        });
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "synthetic test input",
          attachments: [],
        });
        const denied = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            runtimeMode: "full-access",
            maxConcurrentSubagents: 4,
            requireIdleForSubagentLimitChange: true,
          })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        if (denied._tag === "Failure")
          assert.equal(
            "remoteErrorTag" in denied.failure ? denied.failure.remoteErrorTag : null,
            "subagent-concurrency-active",
          );
        for (const maxConcurrentSubagents of [0, 65, 1.5, NaN, Infinity]) {
          const result = yield* adapter
            .startSession({
              threadId: THREAD_ID,
              runtimeMode: "full-access",
              maxConcurrentSubagents,
            })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
        }
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(harness.query.interruptCalls.length, 0);
        assert.equal(harness.createInputs.length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "refuses concurrency replacement with an uncertain hidden child after an idle root",
    () => {
      const harness = makeHarness({ subagentConcurrencySupported: true, environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 8,
        });
        const childObserved = yield* Stream.runHead(
          adapter.streamEvents.pipe(Stream.filter((event) => event.type === "task.started")),
        ).pipe(Effect.forkChild);
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "hidden-child",
          tool_use_id: "hidden-tool",
          task_type: "local_agent",
          spawn_depth: 1,
          skip_transcript: true,
          description: "Private background child",
          session_id: "synthetic-session",
          uuid: "synthetic-hidden-start",
        } as unknown as SDKMessage);
        yield* Fiber.join(childObserved);
        const denied = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            runtimeMode: "full-access",
            maxConcurrentSubagents: 4,
            requireIdleForSubagentLimitChange: true,
          })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(harness.query.interruptCalls.length, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "refuses retirement while a consumed SDK child message is blocked before native status binding",
    () =>
      Effect.gen(function* () {
        const loggerEntered = yield* Deferred.make<void>();
        const releaseLogger = yield* Deferred.make<void>();
        const harness = makeHarness({
          subagentConcurrencySupported: true,
          environment: {},
          nativeEventLogger: {
            filePath: "memory://in-flight-child-fixture",
            write: () =>
              Deferred.succeed(loggerEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseLogger)),
              ),
            close: () => Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            runtimeMode: "full-access",
            maxConcurrentSubagents: 8,
          });
          harness.query.emit({
            type: "system",
            subtype: "task_started",
            task_id: "consumed-child",
            tool_use_id: "consumed-tool",
            task_type: "local_agent",
            spawn_depth: 1,
            skip_transcript: true,
            description: "Synthetic child",
            session_id: "synthetic-session",
            uuid: "synthetic-consumed-start",
          } as unknown as SDKMessage);
          yield* Deferred.await(loggerEntered);
          const denied = yield* adapter
            .startSession({
              threadId: THREAD_ID,
              runtimeMode: "full-access",
              maxConcurrentSubagents: 4,
              requireIdleForSubagentLimitChange: true,
            })
            .pipe(Effect.result);
          assert.equal(denied._tag, "Failure");
          if (denied._tag === "Failure")
            assert.equal(
              "remoteErrorTag" in denied.failure ? denied.failure.remoteErrorTag : null,
              "subagent-concurrency-active",
            );
          assert.equal(harness.query.closeCalls, 0);
          assert.equal(harness.query.interruptCalls.length, 0);
          assert.equal(harness.createInputs.length, 1);
        }).pipe(
          Effect.ensuring(Deferred.succeed(releaseLogger, undefined)),
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      }),
  );

  it.effect(
    "does not launch a competing Claude query after guarded native closure is inconclusive",
    () => {
      const harness = makeHarness({
        subagentConcurrencySupported: true,
        newQueryPerSession: true,
        environment: {},
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 8,
        });
        harness.query.closeFailure = new Error("private synthetic SDK close detail");
        const denied = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            runtimeMode: "full-access",
            maxConcurrentSubagents: 4,
            requireIdleForSubagentLimitChange: true,
          })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        if (denied._tag === "Failure") {
          assert.equal(
            "remoteErrorTag" in denied.failure ? denied.failure.remoteErrorTag : null,
            "subagent-concurrency-retirement-uncertain",
          );
          assert.equal(JSON.stringify(denied.failure).includes("private synthetic"), false);
        }
        const retry = yield* adapter
          .startSession({
            threadId: THREAD_ID,
            runtimeMode: "full-access",
            maxConcurrentSubagents: 4,
          })
          .pipe(Effect.result);
        assert.equal(retry._tag, "Failure");
        assert.equal(harness.createInputs.length, 1);
        assert.equal(harness.query.closeCalls, 1);
        // Explicit stop can retry the same query and discharge its ownership
        // fence only when native closure is finally conclusive.
        harness.query.closeFailure = undefined;
        yield* adapter.stopSession(THREAD_ID);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 4,
        });
        assert.equal(harness.query.closeCalls, 2);
        assert.equal(harness.createInputs.length, 2);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "fences an ordinary Claude replacement when native close fails during best-effort cleanup",
    () => {
      const harness = makeHarness({ newQueryPerSession: true, environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "full-access" });
        harness.query.closeFailure = new Error("private ordinary-close fixture detail");
        const denied = yield* adapter
          .startSession({ threadId: THREAD_ID, runtimeMode: "full-access" })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        if (denied._tag === "Failure") {
          assert.equal(
            "remoteErrorTag" in denied.failure ? denied.failure.remoteErrorTag : null,
            "subagent-concurrency-retirement-uncertain",
          );
        }
        assert.equal(harness.createInputs.length, 1);
        assert.equal(harness.query.closeCalls, 1);
        harness.query.closeFailure = undefined;
        yield* adapter.stopSession(THREAD_ID);
        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "full-access" });
        assert.equal(harness.createInputs.length, 2);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("binds Manual approvals while loading Claude filesystem settings sources", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      // SDK 0.3.286 delegates an omitted permission mode to native settings,
      // including Auto defaults. Loading those sources must not override the
      // user's explicit Manual policy, on creation or the first prompt.
      assert.equal(createInput?.options.permissionMode, "default");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "inspect with manual approvals",
        interactionMode: "default",
        attachments: [],
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts classifier-backed Claude auto mode without enabling bypass", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
        interactionMode: "auto",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "work autonomously",
        interactionMode: "auto",
        attachments: [],
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards cwd and additional directories into claude query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: "/tmp/project",
        additionalDirectories: ["/tmp/docs", "/tmp/tools"],
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.additionalDirectories, [
        "/tmp/project",
        "/tmp/docs",
        "/tmp/tools",
      ]);
      assert.deepEqual(session.additionalDirectories, ["/tmp/docs", "/tmp/tools"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs Claude SDK sessions with the configured Claude HOME", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.env?.HOME, path.join(os.homedir(), ".claude-work"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it("resolves Claude model options without starting an SDK session", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const cases = [
      {
        name: "Sonnet 5.5 uses medium effort and native context without an API suffix",
        selection: createModelSelection(instanceId, "claude-sonnet-5-5"),
        expected: {
          model: "claude-sonnet-5-5",
          effort: "medium",
          context: undefined,
          settings: {},
        },
      },
      {
        name: "Sonnet 5.5 honors max effort while ignoring stale Fast and 200K choices",
        selection: createModelSelection(instanceId, "claude-sonnet-5-5", [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
          { id: "contextWindow", value: "200k" },
        ]),
        expected: {
          model: "claude-sonnet-5-5",
          effort: "max",
          context: undefined,
          settings: {},
        },
      },
      {
        name: "Opus 5.5 defaults to medium effort and its fixed 1M context",
        selection: createModelSelection(instanceId, "claude-opus-5-5"),
        expected: {
          model: "claude-opus-5-5[1m]",
          effort: "medium",
          context: 1000000,
          settings: {},
        },
      },
      {
        name: "Opus 5.5 preserves explicit max effort and Fast off",
        selection: createModelSelection(instanceId, "claude-opus-5-5", [
          { id: "effort", value: "max" },
          { id: "fastMode", value: false },
        ]),
        expected: {
          model: "claude-opus-5-5[1m]",
          effort: "max",
          context: 1000000,
          settings: { fastMode: false },
        },
      },
      {
        name: "Opus 5 defaults to high effort and its fixed 1M context",
        selection: createModelSelection(instanceId, "claude-opus-5"),
        expected: {
          model: "claude-opus-5[1m]",
          effort: "high",
          context: 1000000,
          settings: {},
        },
      },
      {
        name: "Opus 5 supports max effort and fast mode",
        selection: createModelSelection(instanceId, "claude-opus-5", [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
        expected: {
          model: "claude-opus-5[1m]",
          effort: "max",
          context: 1000000,
          settings: { fastMode: true },
        },
      },
      {
        name: "Opus 5 explicitly disables an inherited fast mode",
        selection: createModelSelection(instanceId, "claude-opus-5", [
          { id: "fastMode", value: false },
        ]),
        expected: {
          model: "claude-opus-5[1m]",
          effort: "high",
          context: 1000000,
          settings: { fastMode: false },
        },
      },
      {
        name: "Opus 4.7 default effort",
        selection: createModelSelection(instanceId, "claude-opus-4-7"),
        expected: { model: "claude-opus-4-7", effort: "xhigh", context: 200000, settings: {} },
      },
      {
        name: "Opus 4.7 explicit effort",
        selection: createModelSelection(instanceId, "claude-opus-4-7", [
          { id: "effort", value: "xhigh" },
        ]),
        expected: { model: "claude-opus-4-7", effort: "xhigh", context: 200000, settings: {} },
      },
      {
        name: "Fable 5 default effort and 1M context",
        selection: createModelSelection(instanceId, "claude-fable-5", [
          { id: "contextWindow", value: "1m" },
        ]),
        expected: { model: "claude-fable-5[1m]", effort: "xhigh", context: 1000000, settings: {} },
      },
      {
        name: "Sonnet unsupported max falls back",
        selection: createModelSelection(instanceId, "claude-sonnet-4-6", [
          { id: "effort", value: "max" },
        ]),
        expected: { model: "claude-sonnet-4-6", effort: "high", context: 200000, settings: {} },
      },
      {
        name: "Haiku ignores adaptive effort",
        selection: createModelSelection(instanceId, "claude-haiku-4-5", [
          { id: "effort", value: "high" },
        ]),
        expected: { model: "claude-haiku-4-5", effort: null, context: undefined, settings: {} },
      },
      {
        name: "Haiku supports thinking toggle",
        selection: createModelSelection(instanceId, "claude-haiku-4-5", [
          { id: "thinking", value: false },
        ]),
        expected: {
          model: "claude-haiku-4-5",
          effort: null,
          context: undefined,
          settings: { alwaysThinkingEnabled: false },
        },
      },
      {
        name: "Sonnet ignores thinking toggle",
        selection: createModelSelection(instanceId, "claude-sonnet-4-6", [
          { id: "thinking", value: false },
        ]),
        expected: { model: "claude-sonnet-4-6", effort: "high", context: 200000, settings: {} },
      },
      {
        name: "Opus 4.8 supports fast mode",
        selection: createModelSelection(instanceId, "claude-opus-4-8", [
          { id: "fastMode", value: true },
        ]),
        expected: {
          model: "claude-opus-4-8",
          effort: "xhigh",
          context: 200000,
          settings: { fastMode: true },
        },
      },
      {
        name: "Opus 4.8 explicitly disables an inherited fast mode",
        selection: createModelSelection(instanceId, "claude-opus-4-8", [
          { id: "fastMode", value: false },
        ]),
        expected: {
          model: "claude-opus-4-8",
          effort: "xhigh",
          context: 200000,
          settings: { fastMode: false },
        },
      },
      {
        name: "Opus 4.6 ignores removed fast mode",
        selection: createModelSelection(instanceId, "claude-opus-4-6", [
          { id: "fastMode", value: true },
        ]),
        expected: {
          model: "claude-opus-4-6",
          effort: "high",
          context: 200000,
          settings: {},
        },
      },
      {
        name: "Sonnet ignores fast mode",
        selection: createModelSelection(instanceId, "claude-sonnet-4-6", [
          { id: "fastMode", value: true },
        ]),
        expected: { model: "claude-sonnet-4-6", effort: "high", context: 200000, settings: {} },
      },
      {
        name: "Sonnet ignores a stale disabled fast mode option",
        selection: createModelSelection(instanceId, "claude-sonnet-4-6", [
          { id: "fastMode", value: false },
        ]),
        expected: { model: "claude-sonnet-4-6", effort: "high", context: 200000, settings: {} },
      },
      {
        name: "Fable ultrathink uses max",
        selection: createModelSelection(instanceId, "claude-fable-5", [
          { id: "effort", value: "ultrathink" },
        ]),
        expected: { model: "claude-fable-5", effort: "max", context: 200000, settings: {} },
      },
      {
        name: "Sonnet ultrathink caps at high",
        selection: createModelSelection(instanceId, "claude-sonnet-4-6", [
          { id: "effort", value: "ultrathink" },
        ]),
        expected: { model: "claude-sonnet-4-6", effort: "high", context: 200000, settings: {} },
      },
    ];

    for (const testCase of cases) {
      const resolved = resolveClaudeModelSessionOptions(testCase.selection);
      assert.equal(resolved.apiModelId, testCase.expected.model, testCase.name);
      assert.equal(resolved.effectiveEffort, testCase.expected.effort, testCase.name);
      assert.equal(resolved.selectedContextWindowTokens, testCase.expected.context, testCase.name);
      assert.deepEqual(
        resolved.settings as unknown,
        testCase.expected.settings as unknown,
        testCase.name,
      );
      assert.equal(resolved.agentProgressSummaries, true, testCase.name);
    }

    const concise = resolveClaudeModelSessionOptions(
      createModelSelection(instanceId, "claude-opus-5", [{ id: "outputStyle", value: "concise" }]),
    );
    assert.deepEqual(concise.settings as unknown, { outputStyle: "Concise" });

    const noProgressSummaries = resolveClaudeModelSessionOptions(
      createModelSelection(instanceId, "claude-opus-5", [
        { id: "agentProgressSummaries", value: false },
      ]),
    );
    assert.equal(noProgressSummaries.agentProgressSummaries, false);

    const unsupportedOutputStyle = resolveClaudeModelSessionOptions(
      createModelSelection(instanceId, "claude-opus-5", [
        { id: "outputStyle", value: "untrusted-custom-style" },
      ]),
    );
    assert.deepEqual(unsupportedOutputStyle.settings as unknown, {});
  });

  it.effect("configures Claude SDK streaming without unused prompt suggestions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.includePartialMessages, true);
      assert.equal(createInput?.options.forwardSubagentText, true);
      assert.equal(createInput?.options.agentProgressSummaries, true);
      assert.equal(createInput?.options.promptSuggestions, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const [name, title, expectedTitle] of [
    ["existing Cafe label", "Cafe's task label", "Cafe's task label"],
    ["missing label fallback", undefined, "Cafe Code task"],
    ["control-only label fallback", "\u0000\n\u202e", "Cafe Code task"],
    ["safe single-line label", "Task\n\u202e title", "Task title"],
    [
      "bounded label",
      "x".repeat(PROVIDER_SESSION_TITLE_MAX_CHARS + 20),
      "x".repeat(PROVIDER_SESSION_TITLE_MAX_CHARS),
    ],
  ] as const) {
    it.effect(`seeds fresh Claude native titles with ${name}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          ...(title !== undefined ? { title } : {}),
          runtimeMode: "full-access",
        });
        assert.equal(harness.getLastCreateQueryInput()?.options.title, expectedTitle);
        // The title is initialization metadata, never appended to user input.
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Do the requested work." });
        const message = yield* Effect.promise(() =>
          readFirstPromptMessage(harness.getLastCreateQueryInput()),
        );
        assert.deepEqual(message?.message.content, [
          { type: "text", text: "Do the requested work." },
        ]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("can disable Claude subagent progress summary model calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [{ id: "agentProgressSummaries", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.agentProgressSummaries, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends and reports an explicit normal-speed Claude session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [{ id: "fastMode", value: false }],
        ),
        runtimeMode: "full-access",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, { fastMode: false });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const configured = events.find((event) => event.type === "session.configured");
      assert.equal(configured?.type, "session.configured");
      if (configured?.type === "session.configured") {
        assert.equal(configured.payload.config.fastMode, false);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("marks streamed Cafe prompts as human-originated Claude input", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Check provider provenance",
        attachments: [],
      });

      const message = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.deepEqual(message?.origin, { kind: "human" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs ultrathink at the model's highest effort with the prompt keyword", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "effort", value: "ultrathink" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "effort", value: "ultrathink" }],
        ),
      });

      const createInput = harness.getLastCreateQueryInput();
      // Ultrathink is the top tier: highest concrete CLI effort (max on
      // Fable 5) plus the upstream deeper-reasoning prompt keyword.
      assert.equal(createInput?.options.effort, "max");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "What's in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "delivers file manifests on Claude sends and steers without widening permissions",
    () => {
      const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-file-attachments-"));
      const harness = makeHarness({ cwd: "/tmp/claude-file-project", baseDir });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(baseDir, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        const { attachmentsDir } = yield* ServerConfig;
        const attachment = yield* Effect.promise(() =>
          storeFileAttachment({
            attachmentsDir,
            threadId: THREAD_ID,
            name: "reference.tex",
            mimeType: "text/plain",
            bytes: Buffer.from("PRIVATE_TEX_BODY_NOT_IN_INITIAL_PROMPT"),
          }),
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "approval-required",
          cwd: "/tmp/claude-file-project",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "inspect",
          attachments: [attachment],
        });
        yield* adapter.steerTurn({
          threadId: session.threadId,
          expectedTurnId: turn.turnId,
          input: "include this too",
          attachments: [attachment],
        });
        const messages = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 2),
        );
        for (const message of messages) {
          const serialized = JSON.stringify(message.message.content);
          assert.include(serialized, "reference.tex");
          assert.include(serialized, ".provider.tex");
          assert.notInclude(serialized, "PRIVATE_TEX_BODY_NOT_IN_INITIAL_PROMPT");
          assert.notInclude(serialized, '"type":"document"');
        }
        assert.deepEqual(harness.getLastCreateQueryInput()?.options.additionalDirectories, [
          "/tmp/claude-file-project",
        ]);
        assert.deepEqual(harness.query.interruptCalls, []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("queues Claude steer input into the active streaming prompt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      assert.equal(adapter.capabilities.liveSteer, "supported");

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first prompt",
        attachments: [],
      });
      const steered = yield* adapter.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "follow-up while active",
        attachments: [],
      });

      assert.equal(steered.turnId, turn.turnId);
      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.equal(promptMessageText(messages[0]), "first prompt");
      assert.equal(promptMessageText(messages[1]), "follow-up while active");
      // Claude Code's interactive correction path is a streamed user message,
      // not an interrupt followed by a replacement turn. A regression here
      // would cancel the running tool, collapse Cafe's work log, and reset the
      // active-turn timer before Claude had incorporated the correction.
      assert.deepEqual(harness.query.interruptCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps one Cafe turn active across a queued Claude follow-up", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "finish the original task",
        attachments: [],
      });
      yield* adapter.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "incorporate this follow-up",
        attachments: [],
      });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      const firstMessageUuid = messages[0]?.uuid;
      const followUpMessageUuid = messages[1]?.uuid;
      assert.isString(firstMessageUuid);
      assert.isString(followUpMessageUuid);
      if (firstMessageUuid === undefined || followUpMessageUuid === undefined) {
        throw new Error("Expected UUID-stamped Claude prompts.");
      }

      harness.query.emit({
        type: "system",
        subtype: "init",
        capabilities: ["msg_lifecycle_v1"],
        session_id: "claude-session-follow-up",
        uuid: "init-follow-up",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "command_lifecycle",
        command_uuid: firstMessageUuid,
        state: "started",
        session_id: "claude-session-follow-up",
        uuid: "lifecycle-first-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "command_lifecycle",
        command_uuid: followUpMessageUuid,
        state: "queued",
        session_id: "claude-session-follow-up",
        uuid: "lifecycle-follow-up-queued",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "claude-session-follow-up",
        uuid: "assistant-first-segment",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-first-segment",
          content: [{ type: "text", text: "Original segment complete." }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["transient first-segment failure"],
        session_id: "claude-session-follow-up",
        uuid: "result-first-segment",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const activeSessions = yield* adapter.listSessions();
      assert.equal(activeSessions[0]?.status, "running");
      assert.equal(activeSessions[0]?.activeTurnId, turn.turnId);
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);

      // The real CLI emits the result before retiring the completed command,
      // then immediately promotes the queued UUID. These lifecycle frames must
      // not create a second synthetic Cafe turn or close the original turn.
      harness.query.emit({
        type: "command_lifecycle",
        command_uuid: firstMessageUuid,
        state: "completed",
        session_id: "claude-session-follow-up",
        uuid: "lifecycle-first-completed",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "command_lifecycle",
        command_uuid: followUpMessageUuid,
        state: "started",
        session_id: "claude-session-follow-up",
        uuid: "lifecycle-follow-up-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "claude-session-follow-up",
        uuid: "assistant-follow-up-segment",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-follow-up-segment",
          content: [{ type: "text", text: "Follow-up incorporated." }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "claude-session-follow-up",
        uuid: "result-follow-up-segment",
        user_message_uuid: followUpMessageUuid,
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const completedSessions = yield* adapter.listSessions();
      assert.equal(completedSessions[0]?.status, "ready");
      assert.equal(completedSessions[0]?.activeTurnId, undefined);
      const snapshot = yield* adapter.readThread(session.threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, turn.turnId);
      assert.equal(snapshot.turns[0]?.items.length, 2);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the turn active when Claude reports another queued turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first prompt",
        attachments: [],
      });
      const [firstMessage] = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 1),
      );
      if (firstMessage?.uuid === undefined) {
        throw new Error("Expected a UUID-stamped Claude prompt.");
      }

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        queued_turn_count: 1,
        user_message_uuid: firstMessage.uuid,
        session_id: "claude-session-provider-queued-turn",
        uuid: "result-before-provider-queued-turn",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const activeSession = (yield* adapter.listSessions())[0];
      assert.equal(activeSession?.status, "running");
      assert.equal(activeSession?.activeTurnId, turn.turnId);
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        queued_turn_count: 0,
        session_id: "claude-session-provider-queued-turn",
        uuid: "result-provider-queue-drained",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const completedSession = (yield* adapter.listSessions())[0];
      assert.equal(completedSession?.status, "ready");
      assert.equal(completedSession?.activeTurnId, undefined);
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("completes one Cafe turn for a coalesced Claude follow-up batch", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first batch message",
        attachments: [],
      });
      yield* adapter.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "coalesced follow-up",
        attachments: [],
      });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      const firstMessageUuid = messages[0]?.uuid;
      const followUpMessageUuid = messages[1]?.uuid;
      if (firstMessageUuid === undefined || followUpMessageUuid === undefined) {
        throw new Error("Expected UUID-stamped Claude prompts.");
      }

      // Claude can dequeue several queued UUIDs into one model turn. Both
      // lifecycle entries become started before the shared assistant/result
      // segment, and the non-representative UUID completes afterward.
      for (const [commandUuid, uuid] of [
        [firstMessageUuid, "lifecycle-coalesced-first-started"],
        [followUpMessageUuid, "lifecycle-coalesced-follow-up-started"],
      ] as const) {
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: commandUuid,
          state: "started",
          session_id: "claude-session-coalesced-follow-up",
          uuid,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "assistant",
        session_id: "claude-session-coalesced-follow-up",
        uuid: "assistant-coalesced-follow-up",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-coalesced-follow-up",
          content: [{ type: "text", text: "Both messages handled together." }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "claude-session-coalesced-follow-up",
        uuid: "result-coalesced-follow-up",
        user_message_uuid: firstMessageUuid,
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.equal((yield* adapter.listSessions())[0]?.status, "running");

      harness.query.emit({
        type: "command_lifecycle",
        command_uuid: followUpMessageUuid,
        state: "completed",
        session_id: "claude-session-coalesced-follow-up",
        uuid: "lifecycle-coalesced-follow-up-completed",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const completedSessions = yield* adapter.listSessions();
      assert.equal(completedSessions[0]?.status, "ready");
      assert.equal(completedSessions[0]?.activeTurnId, undefined);
      const snapshot = yield* adapter.readThread(session.threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, turn.turnId);
      assert.equal(snapshot.turns[0]?.items.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "tracks Claude command lifecycle and cancels only Cafe-owned interrupt survivors",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first prompt",
          attachments: [],
        });
        yield* adapter.steerTurn({
          threadId: session.threadId,
          expectedTurnId: turn.turnId,
          input: "queued steer",
          attachments: [],
        });

        const messages = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 2),
        );
        const firstMessageUuid = messages[0]?.uuid;
        const steerMessageUuid = messages[1]?.uuid;
        assert.isString(firstMessageUuid);
        assert.isString(steerMessageUuid);
        assert.notEqual(firstMessageUuid, steerMessageUuid);
        if (firstMessageUuid === undefined || steerMessageUuid === undefined) {
          throw new Error("Expected Cafe to UUID-stamp both Claude prompt messages.");
        }

        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: firstMessageUuid,
          state: "started",
          uuid: "command-lifecycle-started",
          session_id: "claude-session-lifecycle",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: steerMessageUuid,
          state: "queued",
          uuid: "command-lifecycle-queued",
          session_id: "claude-session-lifecycle",
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        harness.query.interruptResponse = {
          still_queued: [steerMessageUuid, "claude-internal-command"],
        };
        yield* adapter.interruptTurn(session.threadId, turn.turnId);

        assert.equal(harness.query.interruptCalls.length, 1);
        assert.deepEqual(harness.query.cancelAsyncMessageCalls, [steerMessageUuid]);
        assert.equal(harness.query.closeCalls, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("acknowledges only a known first-reply UUID before the result arrives", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first prompt",
        attachments: [],
      });
      yield* adapter.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "queued steer",
        attachments: [],
      });
      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      const firstUuid = messages[0]?.uuid;
      const steerUuid = messages[1]?.uuid;
      assert.isString(firstUuid);
      assert.isString(steerUuid);
      if (!firstUuid || !steerUuid) throw new Error("Expected UUID-stamped prompts.");

      // Unknown provider input must not create lifecycle state. The following
      // known UUID then marks the steer as started, allowing an uncorrelated
      // result to retire exactly that prompt before terminal result metadata.
      for (const [uuid, userMessageUuid] of [
        ["unknown-first-reply", "provider-owned-unknown-uuid"],
        ["known-first-reply", steerUuid],
      ] as const) {
        harness.query.emit({
          type: "stream_event",
          session_id: "claude-session-first-reply-ack",
          uuid,
          parent_tool_use_id: null,
          user_message_uuid: userMessageUuid,
          event: { type: "message_start", message: { id: `message-${uuid}` } },
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        queued_turn_count: 1,
        session_id: "claude-session-first-reply-ack",
        uuid: "uncorrelated-result-after-first-reply",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      harness.query.interruptResponse = { still_queued: [] };
      yield* adapter.interruptTurn(session.threadId, turn.turnId);
      assert.deepEqual(harness.query.cancelAsyncMessageCalls, [firstUuid]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const subtype of ["success", "error_during_execution"] as const) {
    it.effect(`retires every answered prompt from a merged Claude ${subtype} result`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "original task",
          attachments: [],
        });
        for (const input of ["folded into the current reply", "wait for the next reply"]) {
          yield* adapter.steerTurn({
            threadId: session.threadId,
            expectedTurnId: turn.turnId,
            input,
            attachments: [],
          });
        }
        const messages = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 3),
        );
        const [first, folded, pending] = messages.map((message) => message.uuid);
        if (!first || !folded || !pending) throw new Error("Expected UUID-stamped prompts.");

        // No command_lifecycle frames arrive. The result itself is authoritative
        // for the merged/folded inputs, but cannot retire the unconsumed steer.
        const result = {
          type: "result",
          subtype,
          is_error: subtype !== "success",
          errors: subtype === "success" ? [] : ["Recoverable response-segment error"],
          session_id: "claude-merged-prompts",
          uuid: "merged-result",
          user_message_uuid: folded,
          user_message_uuids: [first, folded, folded, "provider-owned-unknown-uuid"],
        } as unknown as SDKMessage;
        harness.query.emit(result);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
        assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);

        // A delayed replay of already-retired correlation must not fall back
        // to consuming the next submitted prompt.
        harness.query.emit(result);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "claude-merged-prompts",
          uuid: "pending-result",
          user_message_uuid: pending,
          user_message_uuids: [pending],
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const completed = (yield* adapter.listSessions())[0];
        assert.equal(completed?.status, "ready");
        assert.equal(completed?.activeTurnId, undefined);
        const snapshot = yield* adapter.readThread(session.threadId);
        assert.equal(snapshot.turns.length, 1);
        assert.equal(snapshot.turns[0]?.id, turn.turnId);
        assert.deepEqual(harness.query.interruptCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  for (const frameType of ["assistant", "stream_event"] as const) {
    for (const nested of [false, true]) {
      it.effect(
        `correlates ${nested ? "no primary prompts from nested" : "all merged prompts from primary"} ${frameType} frames`,
        () => {
          const harness = makeHarness();
          return Effect.gen(function* () {
            const adapter = yield* ClaudeAdapter;
            const session = yield* adapter.startSession({
              threadId: THREAD_ID,
              provider: ProviderDriverKind.make("claudeAgent"),
              runtimeMode: "full-access",
            });
            const turn = yield* adapter.sendTurn({
              threadId: session.threadId,
              input: "not acknowledged by this reply",
              attachments: [],
            });
            for (const input of ["first merged prompt", "last merged prompt"]) {
              yield* adapter.steerTurn({
                threadId: session.threadId,
                expectedTurnId: turn.turnId,
                input,
                attachments: [],
              });
            }
            const messages = yield* Effect.promise(() =>
              readPromptMessages(harness.getLastCreateQueryInput(), 3),
            );
            const [first, merged, representative] = messages.map((message) => message.uuid);
            if (!first || !merged || !representative) throw new Error("Expected prompt UUIDs.");
            harness.query.emit({
              type: frameType,
              session_id: "claude-merged-reply",
              uuid: "first-reply",
              parent_tool_use_id: nested ? "subagent-tool" : null,
              user_message_uuid: representative,
              user_message_uuids: [merged, representative],
              ...(frameType === "assistant"
                ? { message: { id: "reply", content: [] } }
                : { event: { type: "message_start", message: { id: "reply" } } }),
            } as unknown as SDKMessage);
            harness.query.emit({
              type: "result",
              subtype: "success",
              is_error: false,
              queued_turn_count: 1,
              session_id: "claude-merged-reply",
              uuid: "uncorrelated-result",
            } as unknown as SDKMessage);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;

            // A legacy result retires the oldest *started* input. Inspect exact
            // survivors through the existing public stop/cancellation boundary.
            harness.query.interruptResponse = { still_queued: [first, merged, representative] };
            yield* adapter.interruptTurn(session.threadId, turn.turnId);
            assert.deepEqual(
              harness.query.cancelAsyncMessageCalls,
              nested ? [merged, representative] : [first, representative],
            );
          }).pipe(
            Effect.provideService(Random.Random, makeDeterministicRandomService()),
            Effect.provide(harness.layer),
          );
        },
      );
    }
  }

  for (const correlation of ["unknown", "malformed", "empty", "over-limit"] as const) {
    it.effect(`does not retire unrelated prompts from ${correlation} batch correlation`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "must remain pending",
          attachments: [],
        });
        const [message] = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 1),
        );
        if (!message?.uuid) throw new Error("Expected prompt UUID.");
        const foreignUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const batches = {
          unknown: [foreignUuid],
          malformed: [null, 42, { uuid: message.uuid }, ` ${message.uuid}`, "x".repeat(10000)],
          empty: [],
          "over-limit": [...Array<string>(64).fill(foreignUuid), message.uuid],
        };
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "claude-untrusted-correlation",
          uuid: "uncorrelated-result",
          user_message_uuids: batches[correlation],
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
        harness.query.interruptResponse = { still_queued: [message.uuid, foreignUuid] };
        yield* adapter.interruptTurn(session.threadId, turn.turnId);
        assert.deepEqual(harness.query.cancelAsyncMessageCalls, [message.uuid]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("treats correlated thinking as a new segment without completing it early", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "initial prompt",
        attachments: [],
      });
      yield* adapter.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "later segment",
        attachments: [],
      });
      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      const [first, later] = messages.map((message) => message.uuid);
      if (!first || !later) throw new Error("Expected prompt UUIDs.");
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-thinking-correlation",
        uuid: "earlier-result",
        user_message_uuid: first,
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 50,
        estimated_tokens_delta: 50,
        session_id: "claude-thinking-correlation",
        uuid: "later-thinking",
        user_message_uuid: later,
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "command_lifecycle",
        command_uuid: later,
        state: "completed",
        session_id: "claude-thinking-correlation",
        uuid: "later-command-completed",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-thinking-correlation",
        uuid: "later-result",
        user_message_uuid: later,
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const frameType of ["assistant", "stream_event"] as const) {
    it.effect(`tracks successive synthetic-turn answer switches on ${frameType} frames`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const nativeSessionId = "claude-synthetic-answer-switch";
        const foreignUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";

        // A provider-initiated rescue/background reply starts a synthetic Cafe
        // turn. Its identity is not an input Cafe submitted or may cancel.
        harness.query.emit({
          type: "assistant",
          session_id: nativeSessionId,
          uuid: "synthetic-first-reply",
          user_message_uuid: foreignUuid,
          user_message_uuids: [foreignUuid],
          parent_tool_use_id: null,
          message: { id: "synthetic-message", content: [] },
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const turnId = (yield* adapter.listSessions())[0]?.activeTurnId;
        if (!turnId) throw new Error("Expected a provider-initiated active turn.");
        for (const input of ["first folded user input", "second folded user input"]) {
          yield* adapter.steerTurn({
            threadId: session.threadId,
            expectedTurnId: turnId,
            input,
            attachments: [],
          });
        }
        const messages = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 2),
        );
        const [first, later] = messages.map((message) => message.uuid);
        if (!first || !later) throw new Error("Expected UUID-stamped folded inputs.");

        for (const [index, messageUuid] of [first, later].entries()) {
          // A meta result must not fall back to retiring an unrelated queued
          // input. It is deferred while Cafe still owns that input. The newer
          // SDK then stamps the next reply when a folded human send takes over;
          // do not gate that acknowledgement on the first reply of Cafe's turn.
          harness.query.emit({
            ...makeSuccessfulClaudeResult(nativeSessionId),
            uuid:
              index === 0
                ? "00000000-0000-4000-8000-000000000301"
                : "00000000-0000-4000-8000-000000000302",
            user_message_uuid: foreignUuid,
            user_message_uuids: [foreignUuid],
          });
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turnId);
          harness.query.emit({
            type: frameType,
            session_id: nativeSessionId,
            uuid: `folded-reply-${index}`,
            parent_tool_use_id: null,
            user_message_uuid: messageUuid,
            user_message_uuids: [foreignUuid, first, ...(index > 0 ? [later] : [])],
            ...(frameType === "assistant"
              ? { message: { id: `folded-message-${index}`, content: [] } }
              : { event: { type: "message_start", message: { id: `folded-message-${index}` } } }),
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "command_lifecycle",
            command_uuid: messageUuid,
            state: "completed",
            session_id: nativeSessionId,
            uuid: `folded-completed-${index}`,
          } as unknown as SDKMessage);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          // Even the final completed command cannot use the older meta result
          // to terminalize a response segment that has since started replying.
          assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turnId);
          assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);
        }

        harness.query.emit({
          ...makeSuccessfulClaudeResult(nativeSessionId),
          uuid: "00000000-0000-4000-8000-000000000303",
          user_message_uuid: later,
          user_message_uuids: [foreignUuid, first, later],
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        const snapshot = yield* adapter.readThread(session.threadId);
        assert.equal(snapshot.turns.length, 1);
        assert.equal(snapshot.turns[0]?.id, turnId);
        assert.deepEqual(harness.query.interruptCalls, []);
        assert.deepEqual(harness.query.cancelAsyncMessageCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect(
    "correlates result-only zero-inference successes without consuming another input",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "/help",
          attachments: [],
        });
        yield* adapter.steerTurn({
          threadId: session.threadId,
          expectedTurnId: turn.turnId,
          input: "/status",
          attachments: [],
        });
        const messages = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 2),
        );
        const [first, later] = messages.map((message) => message.uuid);
        if (!first || !later) throw new Error("Expected UUID-stamped command inputs.");
        const nativeSessionId = "claude-zero-inference-results";
        const firstResult = {
          ...makeSuccessfulClaudeResult(nativeSessionId),
          uuid: "00000000-0000-4000-8000-000000000304",
          duration_api_ms: 0,
          num_turns: 0,
          user_message_uuid: first,
        } satisfies SDKMessage;
        // SDK 0.3.265 fixes the singular stamp even when no API request/reply
        // exists. Neither a missing plural stamp nor a replay licenses consuming
        // the next owned input. These fixtures never execute provider commands.
        harness.query.emit(firstResult);
        harness.query.emit(firstResult);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
        assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);
        harness.query.emit({
          ...makeSuccessfulClaudeResult(nativeSessionId),
          uuid: "00000000-0000-4000-8000-000000000305",
          duration_api_ms: 0,
          num_turns: 0,
          user_message_uuid: later,
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        const snapshot = yield* adapter.readThread(session.threadId);
        assert.equal(snapshot.turns.length, 1);
        assert.equal(snapshot.turns[0]?.id, turn.turnId);
        assert.equal(snapshot.turns[0]?.items.length, 0);
        assert.deepEqual(harness.query.interruptCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("keeps pending user input through Claude's batched empty background results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Continue the review",
        attachments: [],
      });
      yield* adapter.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turn.turnId,
        input: "Include the latest changes",
        attachments: [],
      });
      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      const [first, later] = messages.map((message) => message.uuid);
      if (!first || !later) throw new Error("Expected UUID-stamped user inputs.");
      const nativeSessionId = "claude-batched-background-completions";
      const emptyBackgroundResult = {
        ...makeSuccessfulClaudeResult(nativeSessionId),
        duration_api_ms: 0,
        num_turns: 0,
        result: "",
        origin: { kind: "task-notification" },
      } satisfies SDKMessage;

      // SDK 0.3.274 keeps one result per internally queued completion even
      // when only the final completion causes inference. Neither intermediary
      // has consumed a client UUID. Local sends can still be awaiting provider
      // admission, so the UUID ledger must survive regardless of queue counts.
      for (const uuid of [
        "00000000-0000-4000-8000-000000000306",
        "00000000-0000-4000-8000-000000000307",
      ] as const) {
        harness.query.emit({ ...emptyBackgroundResult, uuid });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
        assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);
      }

      // A provider-owned turn can subsequently incorporate an actual user
      // send. Its explicit correlation takes precedence over notification
      // origin, including zero-inference local-command results.
      harness.query.emit({
        ...emptyBackgroundResult,
        uuid: "00000000-0000-4000-8000-000000000308",
        user_message_uuid: first,
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
      harness.query.emit({
        ...makeSuccessfulClaudeResult(nativeSessionId),
        uuid: "00000000-0000-4000-8000-000000000309",
        user_message_uuid: later,
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      const snapshot = yield* adapter.readThread(session.threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, turn.turnId);
      assert.deepEqual(harness.query.interruptCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects Claude steer input for a stale active turn id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first prompt",
        attachments: [],
      });

      const exit = yield* Effect.exit(
        adapter.steerTurn({
          threadId: session.threadId,
          expectedTurnId: "turn-stale" as never,
          input: "wrong turn",
          attachments: [],
        }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        assert.include(String(exit.cause), "active turn mismatch");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not close an active user turn when sendTurn is called directly", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const activeTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "keep this turn running",
        attachments: [],
      });
      const secondSendExit = yield* Effect.exit(
        adapter.sendTurn({
          threadId: session.threadId,
          input: "this must use the queued follow-up path",
          attachments: [],
        }),
      );

      assert.equal(secondSendExit._tag, "Failure");
      if (secondSendExit._tag === "Failure") {
        assert.include(String(secondSendExit.cause), "turn/steer");
      }

      const activeSessions = yield* adapter.listSessions();
      assert.equal(activeSessions[0]?.status, "running");
      assert.equal(activeSessions[0]?.activeTurnId, activeTurn.turnId);
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "retires stale Claude sessions and suppresses synthetic assistant text on 401 auth failures",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 510,
          error_status: 401,
          error: "authentication_failed",
          session_id: "stale-claude-session",
          uuid: "api-retry-auth-failure",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "assistant",
          session_id: "stale-claude-session",
          uuid: "assistant-auth-failure",
          parent_tool_use_id: null,
          error: "authentication_failed",
          message: {
            id: "synthetic-auth-failure",
            model: "<synthetic>",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
              },
            ],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
          errors: [],
          session_id: "stale-claude-session",
          uuid: "result-auth-failure",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.equal(
          runtimeEvents.some((event) => event.type === "content.delta"),
          false,
        );

        const completed = runtimeEvents.find((event) => event.type === "turn.completed");
        assert.equal(completed?.type, "turn.completed");
        if (completed?.type === "turn.completed") {
          assert.equal(String(completed.turnId), String(turn.turnId));
          assert.equal(completed.payload.state, "failed");
          assert.include(
            String(completed.payload.errorMessage),
            "Invalid authentication credentials",
          );
        }

        assert.equal(
          runtimeEvents.some((event) => event.type === "session.exited"),
          true,
        );
        assert.equal(harness.query.closeCalls, 1);
        assert.deepEqual(yield* adapter.listSessions(), []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("notifies the driver when a Claude turn fails with an auth error", () => {
    const authStatusChanged = Effect.runSync(Deferred.make<boolean>());
    const harness = makeHarness({
      onAuthStatusChanged: (failed) =>
        Deferred.succeed(authStatusChanged, failed).pipe(Effect.asVoid),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        errors: [],
        session_id: "stale-claude-session",
        uuid: "result-auth-failure",
      } as unknown as SDKMessage);
      assert.equal(yield* Deferred.await(authStatusChanged), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clears the driver auth-failure signal when a Claude turn completes", () => {
    const authStatusChanged = Effect.runSync(Deferred.make<boolean>());
    const harness = makeHarness({
      onAuthStatusChanged: (failed) =>
        Deferred.succeed(authStatusChanged, failed).pipe(Effect.asVoid),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 5,
        duration_api_ms: 5,
        num_turns: 1,
        result: "All good.",
        session_id: "fresh-claude-session",
        uuid: "result-auth-recovered",
      } as unknown as SDKMessage);
      assert.equal(yield* Deferred.await(authStatusChanged), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const resourceUri = "mcp://private-provider/result.txt?token=do-not-persist";
    const nativeEvents: Array<{ event?: { payload?: unknown } }> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-resource-link-native-events",
        write: (event) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              // Claude Code 2.1.258 / Agent SDK 0.3.258 render an MCP
              // resource_link into this text block while retaining the
              // structured resourceLinks metadata beside the user message.
              content: [
                {
                  type: "text",
                  text: `src/example.ts:1:foo\n[Resource link: result.txt] ${resourceUri}`,
                },
              ],
            },
          ],
        },
        tool_use_result: {
          resourceLinks: [
            {
              uri: resourceUri,
              name: "result.txt",
              title: "Search result",
              description: `A bounded provider resource at ${resourceUri}`,
              mimeType: "text/plain",
              size: 42,
              annotations: { secret: "provider-resource-annotation" },
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        const data = toolResultUpdated.payload.data as {
          result?: { content?: Array<{ type?: string; text?: string }> };
          resourceLinks?: Array<Record<string, unknown>>;
        };
        const redactedToolText = data.result?.content?.[0]?.text ?? "";
        assert.include(redactedToolText, "src/example.ts:1:foo");
        assert.include(redactedToolText, "[Resource link: result.txt]");
        assert.match(redactedToolText, /\[resource URI omitted; ref sha256:[a-f0-9]{64}\]/);
        assert.deepInclude(data.resourceLinks?.[0] ?? {}, {
          name: "result.txt",
          title: "Search result",
          mimeType: "text/plain",
          size: 42,
          scheme: "mcp",
        });
        assert.match(String(data.resourceLinks?.[0]?.referenceId), /^sha256:[a-f0-9]{64}$/);
        assert.include(redactedToolText, String(data.resourceLinks?.[0]?.referenceId));
        assert.include(
          String(data.resourceLinks?.[0]?.description),
          "A bounded provider resource at [resource URI omitted; ref sha256:",
        );
        const serializedRaw = JSON.stringify(toolResultUpdated.raw?.payload);
        assert.notInclude(serializedRaw, resourceUri);
        assert.notInclude(serializedRaw, "do-not-persist");
        assert.notInclude(serializedRaw, "provider-resource-annotation");
        assert.notInclude(serializedRaw, "src/example.ts:1:foo");
      }

      const serializedRuntimeEvents = JSON.stringify(runtimeEvents);
      assert.notInclude(serializedRuntimeEvents, resourceUri);
      assert.notInclude(serializedRuntimeEvents, "do-not-persist");
      assert.notInclude(serializedRuntimeEvents, "provider-resource-annotation");
      assert.include(serializedRuntimeEvents, "src/example.ts:1:foo");

      const serializedThread = JSON.stringify(yield* adapter.readThread(session.threadId));
      assert.notInclude(serializedThread, resourceUri);
      assert.notInclude(serializedThread, "do-not-persist");
      assert.include(serializedThread, "src/example.ts:1:foo");

      const serializedNativeEvents = JSON.stringify(nativeEvents);
      assert.notInclude(serializedNativeEvents, resourceUri);
      assert.notInclude(serializedNativeEvents, "do-not-persist");
      assert.notInclude(serializedNativeEvents, "provider-resource-annotation");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "quarantines tool results when resource-link metadata exceeds inspection bounds",
    () => {
      const overflowResourceUri =
        "mcp://private-provider/overflow-report?bearer=entry-101-must-not-persist";
      const nativeEvents: Array<{ event?: { payload?: unknown } }> = [];
      const harness = makeHarness({
        nativeEventLogger: {
          filePath: "memory://claude-resource-link-overflow-native-events",
          write: (event) => {
            nativeEvents.push(event as (typeof nativeEvents)[number]);
            return Effect.void;
          },
          close: () => Effect.void,
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "exercise resource overflow quarantine",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-resource-overflow",
          uuid: "stream-resource-overflow-tool",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-resource-overflow",
              name: "Grep",
              input: {},
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          session_id: "sdk-session-resource-overflow",
          uuid: "user-resource-overflow-result",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-resource-overflow",
                // Deliberately avoid Claude's standard `[Resource link: …] URI`
                // rendering. The URI is known only to structured entry 101, so
                // bounded exact redaction cannot see it and must fail closed.
                content: [
                  {
                    type: "text",
                    text: `Useful-but-untrusted provider output: ${overflowResourceUri}`,
                  },
                ],
              },
            ],
          },
          tool_use_result: {
            resourceLinks: [
              ...Array.from({ length: 100 }, (_, index) => ({
                uri: `mcp://bounded-provider/resource-${index}`,
                name: `resource-${index}`,
              })),
              {
                uri: overflowResourceUri,
                name: "overflow-report",
                annotations: { secret: "overflow-annotation-must-not-persist" },
              },
            ],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-resource-overflow",
          uuid: "result-resource-overflow",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const toolResultUpdated = runtimeEvents.find(
          (event) =>
            event.type === "item.updated" &&
            (event.payload.data as { result?: unknown } | undefined)?.result !== undefined,
        );
        assert.equal(toolResultUpdated?.type, "item.updated");
        if (toolResultUpdated?.type === "item.updated") {
          assert.deepEqual((toolResultUpdated.payload.data as { result?: unknown }).result, {
            type: "tool_result",
            content: "[tool result omitted: resource-link metadata exceeded safety limit]",
          });
        }

        const serializedRuntimeEvents = JSON.stringify(runtimeEvents);
        assert.notInclude(serializedRuntimeEvents, overflowResourceUri);
        assert.notInclude(serializedRuntimeEvents, "entry-101-must-not-persist");
        assert.notInclude(serializedRuntimeEvents, "overflow-annotation-must-not-persist");
        assert.notInclude(serializedRuntimeEvents, "Useful-but-untrusted provider output");

        const serializedThread = JSON.stringify(yield* adapter.readThread(session.threadId));
        assert.notInclude(serializedThread, overflowResourceUri);
        assert.notInclude(serializedThread, "entry-101-must-not-persist");
        assert.notInclude(serializedThread, "Useful-but-untrusted provider output");
        assert.include(serializedThread, "resource-link metadata exceeded safety limit");

        const serializedNativeEvents = JSON.stringify(nativeEvents);
        assert.notInclude(serializedNativeEvents, overflowResourceUri);
        assert.notInclude(serializedNativeEvents, "entry-101-must-not-persist");
        assert.notInclude(serializedNativeEvents, "overflow-annotation-must-not-persist");
        assert.notInclude(serializedNativeEvents, "Useful-but-untrusted provider output");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo-plan",
        uuid: "result-todo-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the previous session before replacing an existing thread session", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const activeSessions = yield* adapter.listSessions();

      assert.equal(queries.length, 2);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, secondSession.resumeCursor);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);

      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const progressFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);
      const progressEvent = Array.from(yield* Fiber.join(progressFiber))[0];
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("redacts Claude plugin load errors before native and configured diagnostics", () => {
    const nativeEvents: Array<{ event?: { method?: string; payload?: unknown } }> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-plugin-diagnostics",
        write: (event) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "session.configured" && event.raw?.method === "claude/system/init",
      ).pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const secret = "must-not-persist-plugin-private-data";
      const privateError = {
        plugin: secret,
        message: `${secret} bearer credential`,
        path: `/private/${secret}/plugin`,
        unknown: { credential: secret },
      };
      // Fixtures cover .283's open-set categories, malformed mixed-version
      // input, a bounded large list, and legacy omission. No provider is run.
      const diagnostics = [
        {
          plugin_errors: [
            ...[
              "path-not-found",
              "manifest-validation-error",
              "dependency-unsatisfied",
              "hook-load-failed",
              "generic-error",
              `__proto__${secret}`,
            ].map((type) => Object.assign({ type }, privateError)),
            null,
          ],
        },
        {
          plugin_errors: Array.from({ length: 65 }, () => ({
            ...privateError,
            type: "generic-error",
          })),
        },
        { plugin_errors: privateError },
        { plugin_error_summary: { forged: secret } },
        { plugin_errors: [] },
      ];
      for (const fields of diagnostics) {
        harness.query.emit({
          type: "system",
          subtype: "init",
          apiKeySource: "none",
          claude_code_version: "2.1.283",
          cwd: "/fixture",
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-5",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: "00000000-0000-4000-8000-000000000000",
          session_id: "sdk-session-plugin-diagnostics",
          ...fields,
        } as SDKMessage);
      }

      const configuredEvents = Array.from(yield* Fiber.join(configuredFiber));
      const nativePayloads = nativeEvents
        .filter((record) => record.event?.method === "claude/system/init")
        .map((record) => record.event?.payload as Record<string, unknown>);
      assert.lengthOf(nativePayloads, diagnostics.length);
      const expectedCategories = {
        "path-not-found": 1,
        "manifest-validation-error": 1,
        "dependency-unsatisfied": 1,
        "hook-load-failed": 1,
        "generic-error": 2,
        malformed: 1,
        uninspected: 0,
      };
      for (const [index, event] of configuredEvents.entries()) {
        assert.equal(event.type, "session.configured");
        if (event.type !== "session.configured") continue;
        const config = event.payload.config;
        const native = nativePayloads[index];
        const raw = event.raw?.payload as Record<string, unknown>;
        for (const payload of [config, native, raw]) {
          assert.notProperty(payload, "plugin_errors");
          assert.notInclude(JSON.stringify(payload), secret);
          assert.equal(payload?.model, "claude-sonnet-5");
          assert.deepEqual(payload?.plugin_error_summary, config.plugin_error_summary);
        }
        const summary = config.plugin_error_summary as
          | { count: number; categories: Record<string, number> }
          | undefined;
        if (index === 0) {
          assert.deepEqual(summary, { count: 7, categories: expectedCategories });
        } else if (index === 1) {
          assert.equal(summary?.count, 65);
          assert.equal(summary?.categories["generic-error"], 64);
          assert.equal(summary?.categories.uninspected, 1);
        } else if (index === 2) {
          assert.equal(summary?.count, 1);
          assert.equal(summary?.categories.malformed, 1);
        } else if (index === 3) {
          assert.notProperty(config, "plugin_error_summary");
        } else {
          assert.equal(summary?.count, 0);
          assert.equal(
            Object.values(summary?.categories ?? {}).every((count) => count === 0),
            true,
          );
        }
      }
      assert.notInclude(JSON.stringify(configuredEvents), secret);
      assert.notInclude(JSON.stringify(nativeEvents), secret);
      assert.lengthOf(harness.query.interruptCalls, 0);
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bounds provider-authored task and hook text in canonical and native records", () => {
    const nativeEvents: Array<{
      event?: {
        method?: string;
        payload?: unknown;
      };
    }> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-bounded-native-events",
        write: (event) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const boundedEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress" || event.type === "hook.completed",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "exercise bounded provider text",
        attachments: [],
      });

      const longDescription = "d".repeat(20_000);
      const longSummary = "s".repeat(20_000);
      const longToolName = "t".repeat(2_000);
      const longHookOutput = "h".repeat(24_000);
      const opaqueMultibyteTaskId = `${"🔐".repeat(600)}provider-secret-tail`;
      const unknownSecret = "must-not-survive-native-allowlisting";
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: opaqueMultibyteTaskId,
        description: longDescription,
        summary: longSummary,
        last_tool_name: longToolName,
        usage: {
          total_tokens: Number.MAX_VALUE,
          tool_uses: -3,
          duration_ms: 1,
          secret_usage_field: unknownSecret,
          nested: { secret: unknownSecret },
        },
        secret_provider_field: unknownSecret,
        session_id: "sdk-session-bounded-provider-text",
        uuid: "task-bounded-provider-text-progress",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "hook-bounded-provider-text",
        hook_name: "PostToolUse",
        hook_event: "PostToolUse",
        output: longHookOutput,
        stdout: longHookOutput,
        stderr: longHookOutput,
        outcome: "success",
        secret_provider_field: unknownSecret,
        session_id: "sdk-session-bounded-provider-text",
        uuid: "hook-bounded-provider-text-response",
      } as unknown as SDKMessage);

      const boundedEvents = Array.from(yield* Fiber.join(boundedEventsFiber));
      const taskEvent = boundedEvents.find((event) => event.type === "task.progress");
      assert.equal(taskEvent?.type, "task.progress");
      if (taskEvent?.type === "task.progress") {
        assert.lengthOf(taskEvent.payload.description ?? "", 1_000);
        // Canonical one-line display text also passes through Cafe's stricter
        // 2,000-character diagnostic-line cap. Raw/native diagnostics retain
        // the adapter's separate 4,000-character task-summary ceiling.
        assert.lengthOf(taskEvent.payload.summary ?? "", 2_000);
        assert.lengthOf(taskEvent.payload.lastToolName ?? "", 256);
        assert.deepEqual(taskEvent.payload.usage, {
          total_tokens: Number.MAX_SAFE_INTEGER,
          tool_uses: 0,
          duration_ms: 1,
        });
        const rawPayload = taskEvent.raw?.payload as Record<string, unknown> | undefined;
        assert.lengthOf(String(rawPayload?.description ?? ""), 1_000);
        assert.lengthOf(String(rawPayload?.summary ?? ""), 4_000);
        assert.lengthOf(String(rawPayload?.last_tool_name ?? ""), 256);
        assert.match(String(rawPayload?.task_id ?? ""), /^sha256:[a-f0-9]{64}$/);
        assert.notInclude(JSON.stringify(rawPayload), "provider-secret-tail");
        assert.notProperty(rawPayload ?? {}, "secret_provider_field");
        assert.notInclude(JSON.stringify(rawPayload?.usage), "secret_usage_field");
      }

      const hookEvent = boundedEvents.find((event) => event.type === "hook.completed");
      assert.equal(hookEvent?.type, "hook.completed");
      if (hookEvent?.type === "hook.completed") {
        assert.lengthOf(hookEvent.payload.output ?? "", 16_000);
        assert.lengthOf(hookEvent.payload.stdout ?? "", 16_000);
        assert.lengthOf(hookEvent.payload.stderr ?? "", 16_000);
        const rawPayload = hookEvent.raw?.payload as Record<string, unknown> | undefined;
        assert.lengthOf(String(rawPayload?.output ?? ""), 16_000);
        assert.lengthOf(String(rawPayload?.stdout ?? ""), 16_000);
        assert.lengthOf(String(rawPayload?.stderr ?? ""), 16_000);
        assert.match(String(rawPayload?.hook_id ?? ""), /^sha256:[a-f0-9]{64}$/);
        assert.notProperty(rawPayload ?? {}, "secret_provider_field");
      }

      for (const method of [
        "claude/system/task_progress",
        "claude/system/hook_response",
      ] as const) {
        const payload = nativeEvents.find((record) => record.event?.method === method)?.event
          ?.payload as Record<string, unknown> | undefined;
        assert.ok(payload, `Expected a native record for ${method}.`);
        if (method === "claude/system/task_progress") {
          assert.lengthOf(String(payload?.description ?? ""), 1_000);
          assert.lengthOf(String(payload?.summary ?? ""), 4_000);
          assert.lengthOf(String(payload?.last_tool_name ?? ""), 256);
          assert.match(String(payload?.task_id ?? ""), /^sha256:[a-f0-9]{64}$/);
          assert.notInclude(JSON.stringify(payload), "provider-secret-tail");
          assert.notProperty(payload ?? {}, "secret_provider_field");
          assert.notInclude(JSON.stringify(payload?.usage), "secret_usage_field");
        } else {
          assert.lengthOf(String(payload?.output ?? ""), 16_000);
          assert.lengthOf(String(payload?.stdout ?? ""), 16_000);
          assert.lengthOf(String(payload?.stderr ?? ""), 16_000);
          assert.match(String(payload?.hook_id ?? ""), /^sha256:[a-f0-9]{64}$/);
          assert.notProperty(payload ?? {}, "secret_provider_field");
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("allowlists task lifecycle fields in native diagnostics", () => {
    const nativeEvents: Array<{ event?: { method?: string; payload?: unknown } }> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-allowlisted-native-events",
        write: (event) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.completed",
      ).pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const sentinel = "provider-private-sentinel";
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "native-task-start",
        tool_use_id: "native-tool-start",
        description: "Native allowlist task",
        prompt: sentinel,
        secret_provider_field: sentinel,
        session_id: "native-session",
        uuid: "native-start-uuid",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "native-task-start",
        patch: { status: "running", summary: "Still running", secret_patch_field: sentinel },
        secret_provider_field: sentinel,
        session_id: "native-session",
        uuid: "native-update-uuid",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "native-task-start",
        status: "completed",
        summary: "Done",
        resource_links: [
          {
            uri: "mcp://private-provider/report?bearer=do-not-persist",
            name: "report",
            description: "Provider report",
            mimeType: "text/markdown",
            annotations: { secret: sentinel },
          },
          {
            uri: "mcp://private-provider/report?bearer=do-not-persist",
            name: "duplicate-report",
          },
          { uri: "mcp://missing-name" },
          { uri: `mcp://${"x".repeat(17_000)}`, name: "oversized-uri" },
          ...Array.from({ length: 55 }, (_, index) => ({
            uri: `mcp://private-provider/extra-${index}`,
            name: `extra-${index}`,
          })),
        ],
        output_file: sentinel,
        secret_provider_field: sentinel,
        session_id: "native-session",
        uuid: "native-notification-uuid",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "native-background-task",
            description: "Background task",
            secret_task_field: sentinel,
          },
        ],
        secret_provider_field: sentinel,
        session_id: "native-session",
        uuid: "native-background-uuid",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(eventsFiber));
      for (const method of [
        "claude/system/task_started",
        "claude/system/task_updated",
        "claude/system/task_notification",
        "claude/system/background_tasks_changed",
      ]) {
        const payload = nativeEvents.find((record) => record.event?.method === method)?.event
          ?.payload as Record<string, unknown> | undefined;
        assert.ok(payload, `Expected a native record for ${method}.`);
        assert.notInclude(JSON.stringify(payload), sentinel);
        assert.notProperty(payload ?? {}, "secret_provider_field");
      }
      const startPayload = nativeEvents.find(
        (record) => record.event?.method === "claude/system/task_started",
      )?.event?.payload as Record<string, unknown>;
      assert.notProperty(startPayload, "prompt");
      const notificationPayload = nativeEvents.find(
        (record) => record.event?.method === "claude/system/task_notification",
      )?.event?.payload as Record<string, unknown>;
      assert.notProperty(notificationPayload, "output_file");
      assert.notInclude(JSON.stringify(notificationPayload), "mcp://private-provider");
      assert.notInclude(JSON.stringify(notificationPayload), "bearer=do-not-persist");
      const completed = taskEvents.find((event) => event.type === "task.completed");
      assert.equal(completed?.type, "task.completed");
      if (completed?.type === "task.completed") {
        assert.lengthOf(completed.payload.resourceLinks ?? [], 50);
        assert.notInclude(JSON.stringify(completed.payload.resourceLinks), sentinel);
        assert.deepInclude(completed.payload.resourceLinks?.[0] ?? {}, {
          name: "report",
          description: "Provider report",
          mimeType: "text/markdown",
          scheme: "mcp",
        });
        assert.match(
          String(completed.payload.resourceLinks?.[0]?.referenceId),
          /^sha256:[a-f0-9]{64}$/,
        );
      }
      const updatePayload = nativeEvents.find(
        (record) => record.event?.method === "claude/system/task_updated",
      )?.event?.payload as { patch?: Record<string, unknown> };
      assert.notProperty(updatePayload.patch ?? {}, "secret_patch_field");
      const backgroundPayload = nativeEvents.find(
        (record) => record.event?.method === "claude/system/background_tasks_changed",
      )?.event?.payload as { tasks?: Array<Record<string, unknown>> };
      assert.notProperty(backgroundPayload.tasks?.[0] ?? {}, "secret_task_field");
      const serializedNativeEvents = JSON.stringify(nativeEvents);
      assert.notInclude(serializedNativeEvents, "native-session");
      assert.notInclude(serializedNativeEvents, "native-tool-start");
      assert.notInclude(serializedNativeEvents, "native-start-uuid");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "preserves structured Claude subagent presentation across task lifecycle events",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const taskEventsFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        ).pipe(Stream.take(8), Stream.runCollect, Effect.forkChild);

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        // A local_agent task carries the provider's durable task id, human task
        // description, agent role, and original objective. Every later edge must
        // repeat that presentation so bounded activity snapshots can render the
        // subagent without retaining the original task_started event forever.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-structured-subagent",
          tool_use_id: "tool-structured-subagent",
          description: "Audit the provider lifecycle",
          subagent_type: "code-reviewer",
          task_type: "local_agent",
          prompt: "Inspect every task event mapping and report exact lifecycle gaps.",
          spawn_depth: 1,
          session_id: "sdk-session-structured-subagent",
          uuid: "task-structured-subagent-started",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-structured-subagent",
          tool_use_id: "tool-structured-subagent",
          description: "Audit the provider lifecycle",
          subagent_type: "code-reviewer",
          summary: "Checking terminal task status handling.",
          usage: {
            total_tokens: 512,
            tool_uses: 3,
            duration_ms: 4_200,
          },
          last_tool_name: "Read",
          session_id: "sdk-session-structured-subagent",
          uuid: "task-structured-subagent-progress",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "task-structured-subagent",
          patch: {
            status: "paused",
          },
          session_id: "sdk-session-structured-subagent",
          uuid: "task-structured-subagent-paused",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-structured-subagent",
          tool_use_id: "tool-structured-subagent",
          status: "completed",
          output_file: "/tmp/structured-subagent-output",
          summary: "Provider lifecycle audit complete.",
          usage: {
            total_tokens: 768,
            tool_uses: 5,
            duration_ms: 6_400,
          },
          session_id: "sdk-session-structured-subagent",
          uuid: "task-structured-subagent-completed",
        } as unknown as SDKMessage);

        // Bash and other generic SDK tasks share task_* lifecycle frames. They
        // must remain ordinary task activity instead of receiving an avatar or
        // being counted as a nested agent merely because they have a task id.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-generic-bash",
          tool_use_id: "tool-generic-bash",
          description: "Build desktop assets",
          task_type: "local_bash",
          session_id: "sdk-session-structured-subagent",
          uuid: "task-generic-bash-started",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-generic-bash",
          tool_use_id: "tool-generic-bash",
          description: "Build desktop assets",
          summary: "Compiling renderer chunks.",
          usage: {
            total_tokens: 0,
            tool_uses: 1,
            duration_ms: 1_200,
          },
          last_tool_name: "Bash",
          session_id: "sdk-session-structured-subagent",
          uuid: "task-generic-bash-progress",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "task-generic-bash",
          patch: {
            status: "running",
          },
          session_id: "sdk-session-structured-subagent",
          uuid: "task-generic-bash-updated",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-generic-bash",
          tool_use_id: "tool-generic-bash",
          status: "completed",
          output_file: "/tmp/generic-bash-output",
          summary: "Desktop assets built.",
          session_id: "sdk-session-structured-subagent",
          uuid: "task-generic-bash-completed",
        } as unknown as SDKMessage);

        const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
        const structuredEvents = taskEvents.filter(
          (event) => event.payload.taskId === RuntimeTaskId.make("task-structured-subagent"),
        );
        assert.equal(structuredEvents.length, 4);

        const expectedStartedAt = structuredEvents[0]?.payload.subagent?.startedAt;
        assert.ok(expectedStartedAt);
        const expectedRuntimeId = (yield* adapter.listSessions())[0]?.subagentRuntimeId;
        assert.ok(expectedRuntimeId);
        const expectedStatuses = ["active", "active", "waiting", "completed"] as const;
        for (const [index, event] of structuredEvents.entries()) {
          assert.deepEqual(event.payload.subagent, {
            threadId: "task-structured-subagent",
            label: "Audit the provider lifecycle",
            role: "code-reviewer",
            objective: "Inspect every task event mapping and report exact lifecycle gaps.",
            status: expectedStatuses[index],
            startedAt: expectedStartedAt,
            runtimeId: expectedRuntimeId,
          });
        }

        const genericEvents = taskEvents.filter(
          (event) => event.payload.taskId === RuntimeTaskId.make("task-generic-bash"),
        );
        assert.equal(genericEvents.length, 4);
        assert.equal(
          genericEvents.every((event) => event.payload.subagent === undefined),
          true,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("retracts and restores ambient tasks on their original owning turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const taskEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.completed",
      ).pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "watch task visibility",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-ambient-flip",
        tool_use_id: "tool-ambient-flip",
        description: "Watch the live update feed",
        subagent_type: "watcher",
        task_type: "local_agent",
        spawn_depth: 1,
        session_id: "sdk-session-ambient-flip",
        uuid: "task-ambient-visible-start",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "task-ambient-flip",
            task_type: "local_agent",
            description: "Watch the live update feed",
            ambient: true,
          },
        ],
        session_id: "sdk-session-ambient-flip",
        uuid: "task-ambient-retracted",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "task-ambient-flip",
            task_type: "local_agent",
            description: "Watch the live update feed",
            ambient: false,
          },
        ],
        session_id: "sdk-session-ambient-flip",
        uuid: "task-ambient-restored",
      } as unknown as SDKMessage);
      // A late patch can turn a previously visible task into transcript-hidden
      // work without completing it. Cafe must emit the authoritative ambient
      // visibility edge against the original owner turn before suppressing any
      // nested transcript frames.
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-ambient-flip",
        patch: {
          status: "running",
          skip_transcript: true,
        },
        session_id: "sdk-session-ambient-flip",
        uuid: "task-skip-transcript-retracted",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-ambient-flip",
        tool_use_id: "tool-ambient-flip",
        status: "completed",
        output_file: "/tmp/ambient-output",
        summary: "Watcher stopped quietly.",
        ambient: true,
        session_id: "sdk-session-ambient-flip",
        uuid: "task-ambient-terminal",
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(taskEventsFiber));
      assert.deepEqual(
        events.map((event) => [event.type, event.payload.visibility, event.turnId]),
        [
          ["task.started", "visible", turn.turnId],
          ["task.progress", "ambient", turn.turnId],
          ["task.progress", "visible", turn.turnId],
          ["task.progress", "ambient", turn.turnId],
          ["task.completed", "ambient", turn.turnId],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reconciles shrinking background snapshots without fabricating completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress" || event.type === "task.completed",
      ).pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "reconcile background snapshot membership",
        attachments: [],
      });

      const snapshotTaskA = {
        task_id: "snapshot-a",
        task_type: "local_agent",
        subagent_type: "reviewer",
        spawn_depth: 1,
        description: "Review snapshot-a",
      };
      const snapshotTaskB = {
        ...snapshotTaskA,
        task_id: "snapshot-b",
        description: "Review snapshot-b",
      };
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [snapshotTaskA, snapshotTaskB],
        session_id: "snapshot-session",
        uuid: "snapshot-full",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [snapshotTaskA],
        session_id: "snapshot-session",
        uuid: "snapshot-shrunk",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
        session_id: "snapshot-session",
        uuid: "snapshot-empty",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "snapshot-b",
        status: "completed",
        summary: "Review B completed.",
        session_id: "snapshot-session",
        uuid: "snapshot-b-terminal",
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(
        new Set(events.map((event) => event.eventId)).size,
        events.length,
        "Each snapshot member and retraction must own a distinct durable event identity",
      );
      assert.deepEqual(
        events.map((event) => [String(event.payload.taskId), event.type, event.payload.visibility]),
        [
          ["snapshot-a", "task.progress", "visible"],
          ["snapshot-b", "task.progress", "visible"],
          ["snapshot-b", "task.progress", "ambient"],
          ["snapshot-a", "task.progress", "ambient"],
          ["snapshot-b", "task.completed", "visible"],
        ],
      );
      assert.equal(
        events.every((event) => event.turnId === turn.turnId),
        true,
      );
      assert.equal(
        events.filter((event) => event.type === "task.completed").length,
        1,
        "snapshot removal itself must never invent a terminal edge",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a terminal task completed when its shrinking snapshot arrives later", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "verify terminal-before-snapshot ordering",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "terminal-before-shrink",
            task_type: "local_agent",
            description: "Finish before the level snapshot shrinks",
          },
        ],
        session_id: "terminal-before-shrink-session",
        uuid: "terminal-before-shrink-full",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "terminal-before-shrink",
        status: "completed",
        summary: "Finished before snapshot reconciliation.",
        session_id: "terminal-before-shrink-session",
        uuid: "terminal-before-shrink-completed",
      } as unknown as SDKMessage);
      // SDK 0.3.251 permits this level update to follow the terminal edge. It
      // must not emit an ambient progress row that deletes the completed row.
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
        session_id: "terminal-before-shrink-session",
        uuid: "terminal-before-shrink-empty",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const targetEvents = runtimeEvents.filter(
        (event) =>
          (event.type === "task.progress" || event.type === "task.completed") &&
          event.payload.taskId === RuntimeTaskId.make("terminal-before-shrink"),
      );
      assert.deepEqual(
        targetEvents.map((event) =>
          event.type === "task.progress" || event.type === "task.completed"
            ? [event.type, event.payload.visibility, event.turnId]
            : [event.type, undefined, event.turnId],
        ),
        [
          ["task.progress", "visible", turn.turnId],
          ["task.completed", "visible", turn.turnId],
        ],
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves provider ambient authority across snapshot omission and completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const targetEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          (event.type === "task.progress" || event.type === "task.completed") &&
          event.payload.taskId === RuntimeTaskId.make("provider-ambient-omission"),
      ).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "provider-ambient-omission",
            description: "Refresh hidden provider metadata",
            ambient: true,
          },
        ],
        session_id: "provider-ambient-omission-session",
        uuid: "provider-ambient-omission-full",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
        session_id: "provider-ambient-omission-session",
        uuid: "provider-ambient-omission-empty",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "provider-ambient-omission",
        status: "completed",
        summary: "Hidden metadata refresh completed.",
        session_id: "provider-ambient-omission-session",
        uuid: "provider-ambient-omission-completed",
      } as unknown as SDKMessage);

      const targetEvents = Array.from(yield* Fiber.join(targetEventsFiber));
      assert.deepEqual(
        targetEvents.map((event) =>
          event.type === "task.progress" || event.type === "task.completed"
            ? [event.type, event.payload.visibility]
            : [event.type, undefined],
        ),
        [
          ["task.progress", "ambient"],
          ["task.progress", "ambient"],
          ["task.completed", "ambient"],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("retracts an omitted task before a full replacement snapshot can evict it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const targetEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.progress" &&
          event.payload.taskId === RuntimeTaskId.make("full-snapshot-eviction-target"),
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "full-snapshot-eviction-target",
            description: "Visible task omitted by the next snapshot",
          },
        ],
        session_id: "full-snapshot-eviction-session",
        uuid: "full-snapshot-eviction-initial",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: Array.from({ length: 4_096 }, (_, index) => ({
          task_id: `full-snapshot-replacement-${index}`,
          description: `Replacement ${index}`,
        })),
        session_id: "full-snapshot-eviction-session",
        uuid: "full-snapshot-eviction-replacement",
      } as unknown as SDKMessage);

      const targetEvents = Array.from(yield* Fiber.join(targetEventsFiber));
      assert.deepEqual(
        targetEvents.map((event) =>
          event.type === "task.progress"
            ? [event.type, event.payload.visibility]
            : [event.type, undefined],
        ),
        [
          ["task.progress", "visible"],
          ["task.progress", "ambient"],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "retains task incarnation authority when a live background binding is restored after generic map eviction",
    () => {
      const harness = makeHarness({ nativeVersion: "2.1.287", environment: {} });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
        });
        const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "work" });
        const observed: ProviderRuntimeEvent[] = [];
        const done = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              observed.push(event);
              if (event.type === "task.progress" && event.payload.summary === "Restored exact task")
                yield* Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkChild,
        );
        const base = {
          type: "system",
          task_id: "reused-task",
          session_id: "synthetic",
          uuid: "00000000-0000-4000-8000-000000000023",
        };
        harness.query.emit({
          ...base,
          subtype: "task_started",
          tool_use_id: "old-tool",
          task_type: "local_bash",
          description: "Old task",
        } as SDKMessage);
        harness.query.emit({
          ...base,
          subtype: "task_notification",
          tool_use_id: "old-tool",
          status: "completed",
          summary: "Old done",
          output_file: "",
        } as SDKMessage);
        harness.query.emit({
          ...base,
          subtype: "task_started",
          tool_use_id: "new-tool",
          task_type: "local_bash",
          description: "New task",
        } as SDKMessage);
        const snapshot = {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "reused-task", description: "New task" }],
          session_id: "synthetic",
          uuid: "snapshot",
        } as unknown as SDKMessage;
        harness.query.emit(snapshot);
        for (let index = 0; index < 4096; index++)
          harness.query.emit({
            ...base,
            subtype: "task_started",
            task_id: `filler-${index}`,
            task_type: "local_bash",
            description: "Filler",
          } as SDKMessage);
        harness.query.emit(snapshot);
        harness.query.emit({
          ...base,
          subtype: "task_notification",
          status: "completed",
          summary: "Ambiguous old result",
          output_file: "",
        } as SDKMessage);
        harness.query.emit({
          ...base,
          subtype: "task_progress",
          tool_use_id: "new-tool",
          description: "New task",
          summary: "Restored exact task",
          usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
        } as SDKMessage);
        yield* Deferred.await(done);
        const initial = observed.findLast(
          (event) => event.type === "task.started" && event.payload.taskId === "reused-task",
        );
        const restored = observed.findLast(
          (event) => event.type === "task.progress" && event.payload.taskId === "reused-task",
        );
        if (initial?.type !== "task.started" || restored?.type !== "task.progress")
          throw new Error("Missing exact binding evidence");
        const reference = restored.payload.individualTaskControl!;
        assert.ok(reference);
        assert.equal(
          reference.capability.taskGeneration,
          initial.payload.individualTaskControl?.capability.taskGeneration,
        );
        assert.equal(
          observed.filter(
            (event) => event.type === "task.completed" && event.payload.taskId === "reused-task",
          ).length,
          1,
        );
        assert.deepEqual(
          yield* adapter.controlTask!({
            threadId: THREAD_ID,
            turnId: turn.turnId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            runtimeId: session.subagentRuntimeId!,
            taskId: reference.taskId,
            taskGeneration: reference.capability.taskGeneration,
            action: "background",
          }),
          { status: "accepted" },
        );
        assert.deepEqual(harness.query.backgroundTaskCalls, ["new-tool"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("retains live background metadata across unrelated generic binding churn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const targetTaskId = RuntimeTaskId.make("generic-churn-background-target");
      const targetEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress" && event.payload.taskId === targetTaskId,
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "retain live background presentation through generic churn",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "generic-churn-background-target",
            description: "Original retained background description",
          },
        ],
        session_id: "generic-churn-background-session",
        uuid: "generic-churn-background-initial",
      } as unknown as SDKMessage);
      // These unrelated task starts fill the generic 4,096-entry binding map
      // and evict its oldest entry. The separate live-background map must keep
      // only the bounded metadata needed for the subsequent omission edge.
      for (let index = 0; index < 4_096; index += 1) {
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: `generic-churn-task-${index}`,
          description: `Generic churn ${index}`,
          session_id: "generic-churn-background-session",
          uuid: `generic-churn-task-start-${index}`,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
        session_id: "generic-churn-background-session",
        uuid: "generic-churn-background-empty",
      } as unknown as SDKMessage);

      const targetEvents = Array.from(yield* Fiber.join(targetEventsFiber));
      assert.deepEqual(
        targetEvents.map((event) =>
          event.type === "task.progress"
            ? [event.payload.visibility, event.payload.description, event.turnId]
            : [undefined, undefined, event.turnId],
        ),
        [
          ["visible", "Original retained background description", turn.turnId],
          ["ambient", "Original retained background description", turn.turnId],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores a retained live member before a later-turn snapshot repeats it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const targetTaskId = RuntimeTaskId.make("retained-member-turn-target");
      const targetEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress" && event.payload.taskId === targetTaskId,
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "start the retained background task",
        attachments: [],
      });

      const retainedTask = {
        task_id: "retained-member-turn-target",
        task_type: "local_agent",
        subagent_type: "reviewer",
        spawn_depth: 1,
        description: "Retained background reviewer",
      };
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [retainedTask],
        session_id: "retained-member-turn-session",
        uuid: "retained-member-turn-initial",
      } as unknown as SDKMessage);
      for (let index = 0; index < 4_096; index += 1) {
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: `retained-member-generic-${index}`,
          description: `Retained-member generic churn ${index}`,
          session_id: "retained-member-turn-session",
          uuid: `retained-member-generic-start-${index}`,
        } as unknown as SDKMessage);
      }

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "Root turn completed while background work continues.",
        session_id: "retained-member-turn-session",
        uuid: "retained-member-first-turn-result",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "begin an unrelated later root turn",
        attachments: [],
      });
      // The task remains present. This repeated snapshot should emit no second
      // row, and it must seed the generic binding from the retained live entry
      // before the following progress frame is attributed.
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [retainedTask],
        session_id: "retained-member-turn-session",
        uuid: "retained-member-turn-repeated",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "retained-member-turn-target",
        description: "Retained background reviewer",
        subagent_type: "reviewer",
        summary: "Still working after the repeated snapshot.",
        usage: {
          total_tokens: 25,
          tool_uses: 1,
          duration_ms: 5_000,
        },
        session_id: "retained-member-turn-session",
        uuid: "retained-member-turn-progress",
      } as unknown as SDKMessage);

      const targetEvents = Array.from(yield* Fiber.join(targetEventsFiber));
      assert.equal(targetEvents.length, 2);
      const firstStartedAt =
        targetEvents[0]?.type === "task.progress"
          ? targetEvents[0].payload.subagent?.startedAt
          : undefined;
      assert.ok(firstStartedAt);
      assert.deepEqual(
        targetEvents.map((event) =>
          event.type === "task.progress"
            ? [
                event.payload.description,
                event.payload.summary,
                event.payload.subagent?.startedAt,
                event.turnId,
              ]
            : [undefined, undefined, undefined, event.turnId],
        ),
        [
          [
            "Retained background reviewer",
            "local_agent background task is running.",
            firstStartedAt,
            firstTurn.turnId,
          ],
          [
            "Retained background reviewer",
            "Still working after the repeated snapshot.",
            firstStartedAt,
            firstTurn.turnId,
          ],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a between-turn task owner null across a later unrelated turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const firstEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          (event.type === "task.started" || event.type === "task.progress") &&
          event.payload.taskId === RuntimeTaskId.make("between-turn-task"),
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "between-turn-task",
        description: "Provider housekeeping",
        session_id: "between-turn-session",
        uuid: "between-turn-start",
      } as unknown as SDKMessage);
      const firstEvent = Array.from(yield* Fiber.join(firstEventFiber))[0];
      const secondEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.progress" &&
          event.payload.taskId === RuntimeTaskId.make("between-turn-task"),
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "start an unrelated root turn",
        attachments: [],
      });
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "between-turn-task",
        patch: { status: "running", skip_transcript: true },
        session_id: "between-turn-session",
        uuid: "between-turn-update",
      } as unknown as SDKMessage);

      const secondEvent = Array.from(yield* Fiber.join(secondEventFiber))[0];
      const events = [firstEvent, secondEvent].filter((event) => event !== undefined);
      assert.deepEqual(
        events.map((event) => [
          event.type,
          event.turnId,
          event.type === "task.started" || event.type === "task.progress"
            ? event.payload.visibility
            : undefined,
        ]),
        [
          ["task.started", undefined, "visible"],
          ["task.progress", undefined, "ambient"],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps ambient visibility fail-closed after its task binding is evicted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const targetTaskId = RuntimeTaskId.make("ambient-eviction-target");
      const targetEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          (event.type === "task.started" || event.type === "task.progress") &&
          event.payload.taskId === targetTaskId,
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "ambient-eviction-target",
        description: "Ambient target",
        ambient: true,
        session_id: "eviction-session",
        uuid: "eviction-target-start",
      } as unknown as SDKMessage);
      // Exceed both the binding and ambient-fallback ceilings so the original
      // identities are forgotten. Overflow changes unknown visibility to a
      // session-level fail-closed default until an explicit visible edge arrives.
      for (let index = 0; index < 4_096; index += 1) {
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: `eviction-filler-${index}`,
          description: `Filler ${index}`,
          ambient: true,
          session_id: "eviction-session",
          uuid: `eviction-filler-start-${index}`,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "ambient-eviction-target",
        description: "Ambient target",
        summary: "Target remains ambient after eviction.",
        session_id: "eviction-session",
        uuid: "eviction-target-after-eviction",
      } as unknown as SDKMessage);

      const targetEvents = Array.from(yield* Fiber.join(targetEventsFiber));
      assert.equal(targetEvents.length, 2);
      assert.equal(
        targetEvents.every(
          (event) =>
            (event.type === "task.started" || event.type === "task.progress") &&
            event.payload.visibility === "ambient",
        ),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("binds Claude task, tool, and history identities without assuming equality", () => {
    const sessionId = "00000000-0000-4000-8000-000000000901";
    const taskId = "task-public-901";
    const toolUseId = "tool-parent-901";
    const historyId = "agent-history-901";
    const historyCalls: Array<{
      readonly sessionId: string;
      readonly historyId: string;
      readonly dir?: string;
    }> = [];
    const historyMessages: SessionMessage[] = [
      {
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000902",
        session_id: sessionId,
        parent_tool_use_id: toolUseId,
        parent_agent_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Audit the public lifecycle." },
            {
              type: "tool_result",
              tool_use_id: "private-tool",
              content: "PRIVATE TOOL RESULT",
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000903",
        session_id: sessionId,
        parent_tool_use_id: toolUseId,
        parent_agent_id: null,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE REASONING" },
            { type: "text", text: "The lifecycle audit is complete." },
            { type: "tool_use", id: "private-call", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "system",
        uuid: "00000000-0000-4000-8000-000000000904",
        session_id: sessionId,
        parent_tool_use_id: toolUseId,
        parent_agent_id: null,
        message: { content: "PRIVATE SYSTEM CONTENT" },
      },
    ];
    const harness = makeHarness({
      listNativeSubagents: async (requestedSessionId, options) => {
        assert.equal(requestedSessionId, sessionId);
        assert.equal(options?.dir, "/tmp/public-project");
        return [historyId];
      },
      getNativeSubagentMessages: async (requestedSessionId, requestedHistoryId, options) => {
        historyCalls.push({
          sessionId: requestedSessionId,
          historyId: requestedHistoryId,
          ...(options?.dir ? { dir: options.dir } : {}),
        });
        return historyMessages;
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const historyBindingFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.completed" && event.payload.subagent?.historyId === historyId,
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: "/tmp/public-project",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate exact work",
        attachments: [],
      });
      harness.query.emit({
        type: "stream_event",
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-000000000905",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: toolUseId,
            name: "Agent",
            input: { description: "Audit lifecycle", prompt: "Inspect exact ids" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        tool_use_id: toolUseId,
        description: "Audit lifecycle",
        subagent_type: "code-reviewer",
        task_type: "local_agent",
        spawn_depth: 1,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-000000000906",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-000000000907",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: "Subagent completed.",
            },
          ],
        },
        tool_use_result: {
          status: "completed",
          agentId: historyId,
          prompt: "Inspect exact ids",
          content: [{ type: "text", text: "Subagent completed." }],
          totalToolUseCount: 1,
          totalDurationMs: 5,
          totalTokens: 10,
          usage: {},
        },
      } as unknown as SDKMessage);

      const bindingEvent = Array.from(yield* Fiber.join(historyBindingFiber))[0];
      assert.equal(bindingEvent?.type, "task.completed");
      if (bindingEvent?.type === "task.completed") {
        assert.equal(bindingEvent.payload.taskId, RuntimeTaskId.make(taskId));
        assert.equal(bindingEvent.payload.subagent?.threadId, taskId);
        assert.equal(bindingEvent.payload.subagent?.historyId, historyId);
      }
      assert.notEqual(taskId, toolUseId);
      assert.notEqual(toolUseId, historyId);

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const detail = yield* readSubagentDetail(THREAD_ID, taskId, {
        historyId,
        cwd: "/tmp/public-project",
      });
      assert.deepEqual(
        detail.messages.map(({ role, text }) => ({ role, text })),
        [
          { role: "user", text: "Audit the public lifecycle." },
          { role: "assistant", text: "The lifecycle audit is complete." },
        ],
      );
      assert.deepEqual(detail.gaps, []);
      assert.equal(detail.truncated, false);
      assert.deepEqual(historyCalls, [{ sessionId, historyId, dir: "/tmp/public-project" }]);
      assert.equal(JSON.stringify(detail).includes("PRIVATE"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resolves a live Claude history id only by exact parent tool metadata", () => {
    const sessionId = "00000000-0000-4000-8000-000000000911";
    const taskId = "task-live-911";
    const toolUseId = "tool-live-911";
    const matchingHistoryId = "agent-live-911";
    const historyCalls: Array<{ readonly id: string; readonly limit?: number }> = [];
    const historyMessage = (id: string, parentToolUseId: string, text: string): SessionMessage => ({
      type: "assistant",
      uuid: `00000000-0000-4000-8000-${id === matchingHistoryId ? "000000000912" : "000000000913"}`,
      session_id: sessionId,
      parent_tool_use_id: parentToolUseId,
      parent_agent_id: null,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    const harness = makeHarness({
      listNativeSubagents: async () => ["agent-unrelated-911", matchingHistoryId],
      getNativeSubagentMessages: async (_sessionId, id, options) => {
        historyCalls.push({
          id,
          ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        });
        if (id === matchingHistoryId) {
          return [historyMessage(id, toolUseId, "Latest verified activity")];
        }
        return [historyMessage(id, "different-parent-tool", "Unrelated private activity")];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const taskStartedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.started" && String(event.payload.taskId) === taskId,
      ).pipe(Stream.take(1), Stream.runDrain, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: "/tmp/live-history-project",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "delegate live history work",
        attachments: [],
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        tool_use_id: toolUseId,
        description: "Live metadata resolution",
        task_type: "local_agent",
        spawn_depth: 1,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-000000000914",
      } as unknown as SDKMessage);
      yield* Fiber.join(taskStartedFiber);

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const resolvedProgressFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.progress" &&
          String(event.payload.taskId) === taskId &&
          event.payload.subagent?.historyId === matchingHistoryId,
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const detail = yield* readSubagentDetail(THREAD_ID, taskId, {
        cwd: "/tmp/live-history-project",
      });
      assert.equal(detail.messages.at(-1)?.text, "Latest verified activity");
      const resolvedProgress = Array.from(yield* Fiber.join(resolvedProgressFiber))[0];
      assert.equal(resolvedProgress?.type, "task.progress");
      if (resolvedProgress?.type === "task.progress") {
        assert.equal(resolvedProgress.payload.subagent?.historyId, matchingHistoryId);
      }

      const forwardedProgressFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "task.progress" && event.payload.summary === "Forwarded latest activity",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      harness.query.emit({
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000915",
        session_id: sessionId,
        parent_tool_use_id: toolUseId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Forwarded latest activity" }],
        },
      } as unknown as SDKMessage);
      const forwardedProgress = Array.from(yield* Fiber.join(forwardedProgressFiber))[0];
      assert.equal(forwardedProgress?.type, "task.progress");
      if (forwardedProgress?.type === "task.progress") {
        assert.equal(forwardedProgress.payload.subagent?.historyId, matchingHistoryId);
      }
      assert.deepEqual(historyCalls, [
        { id: "agent-unrelated-911", limit: 1 },
        { id: matchingHistoryId, limit: 1 },
        { id: matchingHistoryId },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reads ended Claude history only with an exact persisted history binding", () => {
    const sessionId = "00000000-0000-4000-8000-000000000921";
    const historyId = "agent-ended-921";
    let messageReadCount = 0;
    const harness = makeHarness({
      listNativeSubagents: async (_sessionId, options) => {
        assert.equal(options?.dir, "/tmp/ended-history-project");
        return [historyId];
      },
      getNativeSubagentMessages: async () => {
        messageReadCount += 1;
        return [
          {
            type: "assistant",
            uuid: "00000000-0000-4000-8000-000000000922",
            session_id: sessionId,
            parent_tool_use_id: "tool-ended-921",
            parent_agent_id: null,
            message: { role: "assistant", content: "Ended result remains available." },
          },
        ];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const detail = yield* readSubagentDetail(THREAD_ID, "task-ended-921", {
        resumeCursor: { resume: sessionId, turnCount: 1 },
        cwd: "/tmp/ended-history-project",
        historyId,
      });
      assert.equal(detail.messages[0]?.text, "Ended result remains available.");
      assert.equal(messageReadCount, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "keeps an ended Claude child pinned to its persisted root when another root is live",
    () => {
      const liveSessionId = "00000000-0000-4000-8000-000000000923";
      const persistedSessionId = "00000000-0000-4000-8000-000000000924";
      const historyId = "agent-ended-root-923";
      const historyReads: Array<{
        readonly operation: "list" | "messages";
        readonly sessionId: string;
        readonly dir?: string;
      }> = [];
      const harness = makeHarness({
        listNativeSubagents: async (sessionId, options) => {
          historyReads.push({
            operation: "list",
            sessionId,
            ...(options?.dir ? { dir: options.dir } : {}),
          });
          return [historyId];
        },
        getNativeSubagentMessages: async (sessionId, requestedHistoryId, options) => {
          assert.equal(requestedHistoryId, historyId);
          historyReads.push({
            operation: "messages",
            sessionId,
            ...(options?.dir ? { dir: options.dir } : {}),
          });
          return [
            {
              type: "assistant",
              uuid: "00000000-0000-4000-8000-000000000925",
              session_id: persistedSessionId,
              parent_tool_use_id: "tool-ended-root-923",
              parent_agent_id: null,
              message: { role: "assistant", content: "Persisted-root result." },
            },
          ];
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const liveRootStarted = yield* Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.type === "thread.started" && event.payload.providerThreadId === liveSessionId,
        ).pipe(Stream.take(1), Stream.runDrain, Effect.forkChild);
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd: "/tmp/live-history-root",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "keep the replacement native root active",
          attachments: [],
        });
        harness.query.emit({
          type: "system",
          subtype: "init",
          capabilities: [],
          session_id: liveSessionId,
          uuid: "00000000-0000-4000-8000-000000000926",
        } as unknown as SDKMessage);
        yield* Fiber.join(liveRootStarted);

        const readSubagentDetail = adapter.readSubagentDetail;
        assert.ok(readSubagentDetail);
        const detail = yield* readSubagentDetail(THREAD_ID, "task-ended-root-923", {
          resumeCursor: { resume: persistedSessionId, turnCount: 1 },
          cwd: "/tmp/persisted-history-root",
          historyId,
        });

        assert.equal(detail.messages[0]?.text, "Persisted-root result.");
        assert.deepEqual(historyReads, [
          {
            operation: "list",
            sessionId: persistedSessionId,
            dir: "/tmp/persisted-history-root",
          },
          {
            operation: "messages",
            sessionId: persistedSessionId,
            dir: "/tmp/persisted-history-root",
          },
        ]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "reads an active subagent from the configured Claude home through the official SDK store",
    () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cafe-claude-detail-home-"));
      const customHome = path.join(tempRoot, "custom-home");
      const cwd = path.join(tempRoot, "workspace");
      const sessionId = "00000000-0000-4000-8000-000000000941";
      const taskId = "task-custom-home-941";
      const toolUseId = "tool-custom-home-941";
      const historyId = "agent-custom-home-941";
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const projectKey = encodeClaudeProjectDirectoryName(realpathSync(cwd));
      const subagentDirectory = path.join(
        customHome,
        ".claude",
        "projects",
        projectKey,
        sessionId,
        "subagents",
      );
      mkdirSync(subagentDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(subagentDirectory, `agent-${historyId}.jsonl`),
        `${[
          {
            type: "user",
            uuid: "00000000-0000-4000-8000-000000000942",
            parentUuid: null,
            sessionId,
            timestamp: "2026-08-25T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "Inspect the configured-home path." }],
            },
          },
          {
            type: "assistant",
            uuid: "00000000-0000-4000-8000-000000000943",
            parentUuid: "00000000-0000-4000-8000-000000000942",
            sessionId,
            timestamp: "2026-08-25T00:00:01.000Z",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "PRIVATE CUSTOM-HOME REASONING" },
                { type: "text", text: "Configured-home history is live." },
              ],
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      writeFileSync(
        path.join(subagentDirectory, `agent-${historyId}.meta.json`),
        JSON.stringify({
          // Keep this deliberately different from taskId/historyId. The
          // official SDK projects it onto SessionMessage.parent_tool_use_id,
          // which is the only active discovery relationship Cafe accepts.
          toolUseId,
          type: "attacker-controlled-discriminator",
        }),
        { encoding: "utf8", mode: 0o600 },
      );

      const harness = makeHarness({
        cwd,
        claudeConfig: { homePath: customHome },
        // Explicitly mask any developer-machine CLAUDE_CONFIG_DIR. The read
        // must follow this adapter instance's configured home, never ambient
        // process-global Claude state.
        environment: { ...process.env, CLAUDE_CONFIG_DIR: undefined },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const taskStartedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "task.started" && String(event.payload.taskId) === taskId,
        ).pipe(Stream.take(1), Stream.runDrain, Effect.forkChild);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd,
          runtimeMode: "full-access",
        });
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: taskId,
          tool_use_id: toolUseId,
          description: "Configured-home SDK history",
          task_type: "local_agent",
          spawn_depth: 1,
          session_id: sessionId,
          uuid: "00000000-0000-4000-8000-000000000944",
        } as unknown as SDKMessage);
        yield* Fiber.join(taskStartedFiber);

        const readSubagentDetail = adapter.readSubagentDetail;
        assert.ok(readSubagentDetail);
        const detail = yield* readSubagentDetail(THREAD_ID, taskId, { cwd });
        assert.deepEqual(
          detail.messages.map(({ role, text }) => ({ role, text })),
          [
            { role: "user", text: "Inspect the configured-home path." },
            { role: "assistant", text: "Configured-home history is live." },
          ],
        );
        assert.equal(JSON.stringify(detail).includes("PRIVATE"), false);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(tempRoot, { recursive: true, force: true });
          }),
        ),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("rejects a symlinked Claude history session before reading its transcript", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cafe-claude-detail-symlink-"));
    const customHome = path.join(tempRoot, "custom-home");
    const cwd = path.join(tempRoot, "workspace");
    const sessionId = "00000000-0000-4000-8000-000000000951";
    const historyId = "agent-symlink-951";
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const projectKey = encodeClaudeProjectDirectoryName(realpathSync(cwd));
    const projectDirectory = path.join(customHome, ".claude", "projects", projectKey);
    const decoySession = path.join(tempRoot, "decoy-session");
    const decoySubagents = path.join(decoySession, "subagents");
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(decoySubagents, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(decoySubagents, `agent-${historyId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000952",
        parentUuid: null,
        sessionId,
        message: { role: "assistant", content: "PRIVATE SYMLINK TARGET" },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      symlinkSync(
        decoySession,
        path.join(projectDirectory, sessionId),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (cause) {
      if (
        process.platform === "win32" &&
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "EPERM"
      ) {
        rmSync(tempRoot, { recursive: true, force: true });
        return Effect.void;
      }
      throw cause;
    }

    const harness = makeHarness({
      cwd,
      claudeConfig: { homePath: customHome },
      environment: { ...process.env, CLAUDE_CONFIG_DIR: undefined },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const result = yield* readSubagentDetail(THREAD_ID, "task-symlink-951", {
        resumeCursor: { resume: sessionId, turnCount: 1 },
        cwd,
        historyId,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderSubagentDetailReadError");
        if (result.failure._tag === "ProviderSubagentDetailReadError") {
          assert.equal(result.failure.reason, "provider-request-failed");
        }
        assert.equal(JSON.stringify(result.failure).includes("PRIVATE SYMLINK TARGET"), false);
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(tempRoot, { recursive: true, force: true });
        }),
      ),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects mismatched or unsafe Claude history ids before reading content", () => {
    let messageReadCount = 0;
    const harness = makeHarness({
      listNativeSubagents: async () => ["agent-authorized-931"],
      getNativeSubagentMessages: async () => {
        messageReadCount += 1;
        return [];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const mismatched = yield* readSubagentDetail(THREAD_ID, "task-ended-931", {
        resumeCursor: {
          resume: "00000000-0000-4000-8000-000000000931",
          turnCount: 1,
        },
        cwd: "/tmp/mismatched-history-project",
        historyId: "agent-attacker-931",
      }).pipe(Effect.result);
      assert.equal(mismatched._tag, "Failure");
      if (mismatched._tag === "Failure") {
        assert.equal(mismatched.failure._tag, "ProviderSubagentDetailReadError");
        if (mismatched.failure._tag === "ProviderSubagentDetailReadError") {
          assert.equal(mismatched.failure.reason, "child-identity-mismatch");
          assert.equal("stack" in mismatched.failure, false);
        }
      }

      const unsafe = yield* readSubagentDetail(THREAD_ID, "task-ended-931", {
        resumeCursor: {
          resume: "00000000-0000-4000-8000-000000000931",
          turnCount: 1,
        },
        cwd: "/tmp/mismatched-history-project",
        historyId: "../private-agent",
      }).pipe(Effect.result);
      assert.equal(unsafe._tag, "Failure");
      if (unsafe._tag === "Failure" && unsafe.failure._tag === "ProviderSubagentDetailReadError") {
        assert.equal(unsafe.failure.reason, "invalid-request");
      }
      assert.equal(messageReadCount, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses padded opaque Claude history keys before native history I/O", () => {
    let listCount = 0;
    let messageCount = 0;
    const harness = makeHarness({
      listNativeSubagents: async () => {
        listCount += 1;
        return ["agent-authorized-exact"];
      },
      getNativeSubagentMessages: async () => {
        messageCount += 1;
        return [];
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      assert.ok(adapter.readSubagentDetail);
      for (const historyId of [" agent-authorized-exact", "agent-authorized-exact "]) {
        const result = yield* adapter
          .readSubagentDetail(THREAD_ID, "task-ended-exact", {
            resumeCursor: { resume: "00000000-0000-4000-8000-000000000931", turnCount: 1 },
            cwd: "/synthetic/exact-history-project",
            historyId,
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (
          result._tag === "Failure" &&
          result.failure._tag === "ProviderSubagentDetailReadError"
        ) {
          assert.equal(result.failure.reason, "invalid-request");
        }
      }
      assert.equal(listCount, 0);
      assert.equal(messageCount, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "cryptographically bounds hostile Claude task and tool identities across the full lifecycle",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const taskEventsFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        ).pipe(Stream.take(9), Stream.runCollect, Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "delegate hostile identity checks",
          attachments: [],
        });

        // Both pairs share substantially more than the 512-byte retention
        // limit. Their only differences live at the tail, so a truncation-based
        // implementation would merge the task lifecycles and tool aliases.
        const sharedTaskPrefix = `task-${"shared-provider-prefix-".repeat(32)}`;
        const firstRawTaskId = `${sharedTaskPrefix}first-tail`;
        const secondRawTaskId = `${sharedTaskPrefix}second-tail`;
        const sharedToolPrefix = `tool-${"shared-provider-prefix-".repeat(32)}`;
        const firstRawToolUseId = `${sharedToolPrefix}first-tail`;
        const secondRawToolUseId = `${sharedToolPrefix}second-tail`;
        assert.ok(Buffer.byteLength(sharedTaskPrefix, "utf8") > 512);
        assert.ok(Buffer.byteLength(sharedToolPrefix, "utf8") > 512);

        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: firstRawTaskId,
          tool_use_id: firstRawToolUseId,
          description: "Audit the first oversized identity",
          subagent_type: "identity-auditor",
          task_type: "local_agent",
          prompt: "Track the first hostile lifecycle without confusing it with its sibling.",
          spawn_depth: 1,
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-first-started",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: secondRawTaskId,
          tool_use_id: secondRawToolUseId,
          description: "Audit the second oversized identity",
          subagent_type: "identity-auditor",
          task_type: "local_agent",
          prompt: "Track the second hostile lifecycle independently.",
          spawn_depth: 1,
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-second-started",
        } as unknown as SDKMessage);

        // Nested assistant frames carry only parent_tool_use_id. This proves
        // the bounded tool-use map still resolves the first task after another
        // hostile id with the same long prefix has been registered.
        harness.query.emit({
          type: "assistant",
          parent_tool_use_id: firstRawToolUseId,
          subagent_type: "identity-auditor",
          task_description: "Audit the first oversized identity",
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-first-nested-progress",
          message: {
            id: "bounded-first-nested-message",
            role: "assistant",
            content: [{ type: "text", text: "The first oversized identity remains isolated." }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: firstRawTaskId,
          tool_use_id: firstRawToolUseId,
          description: "Audit the first oversized identity",
          summary: "Checking the task-id binding map.",
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-first-progress",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: firstRawTaskId,
          patch: { status: "paused" },
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-first-updated",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: secondRawTaskId,
          tool_use_id: secondRawToolUseId,
          status: "failed",
          summary: "The second lifecycle ended independently.",
          output_file: "/tmp/bounded-second-output",
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-second-completed",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: firstRawTaskId,
          tool_use_id: firstRawToolUseId,
          status: "completed",
          summary: "The first lifecycle completed.",
          output_file: "/tmp/bounded-first-output",
          session_id: "sdk-session-bounded-identities",
          uuid: "bounded-first-completed",
        } as unknown as SDKMessage);

        // Ordinary provider ids retain their exact public identity rather than
        // paying the readability cost of an unnecessary digest.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "ordinary-task-id",
          tool_use_id: "ordinary-tool-use-id",
          description: "Audit an ordinary identity",
          subagent_type: "identity-auditor",
          task_type: "local_agent",
          session_id: "sdk-session-bounded-identities",
          uuid: "ordinary-task-started",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "ordinary-task-id",
          tool_use_id: "ordinary-tool-use-id",
          status: "completed",
          summary: "The ordinary lifecycle completed.",
          output_file: "/tmp/ordinary-task-output",
          session_id: "sdk-session-bounded-identities",
          uuid: "ordinary-task-completed",
        } as unknown as SDKMessage);

        const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
        const firstStarted = taskEvents.find(
          (event) =>
            event.type === "task.started" &&
            event.payload.description === "Audit the first oversized identity",
        );
        const secondStarted = taskEvents.find(
          (event) =>
            event.type === "task.started" &&
            event.payload.description === "Audit the second oversized identity",
        );
        assert.equal(firstStarted?.type, "task.started");
        assert.equal(secondStarted?.type, "task.started");
        if (firstStarted?.type !== "task.started" || secondStarted?.type !== "task.started") {
          return;
        }

        const firstCanonicalTaskId = String(firstStarted.payload.taskId);
        const secondCanonicalTaskId = String(secondStarted.payload.taskId);
        assert.match(firstCanonicalTaskId, /^claude-task-sha256:[0-9a-f]{64}$/u);
        assert.match(secondCanonicalTaskId, /^claude-task-sha256:[0-9a-f]{64}$/u);
        assert.notEqual(firstCanonicalTaskId, firstRawTaskId);
        assert.notEqual(secondCanonicalTaskId, secondRawTaskId);
        assert.notEqual(firstCanonicalTaskId, secondCanonicalTaskId);

        const firstLifecycle = taskEvents.filter(
          (event) => String(event.payload.taskId) === firstCanonicalTaskId,
        );
        assert.equal(firstLifecycle.length, 5);
        assert.deepEqual(
          firstLifecycle.map((event) => event.payload.subagent?.status),
          ["active", "active", "active", "waiting", "completed"],
        );
        assert.equal(
          firstLifecycle.every(
            (event) => event.payload.subagent?.threadId === firstCanonicalTaskId,
          ),
          true,
        );
        const nestedProgress = firstLifecycle.find(
          (event) =>
            event.type === "task.progress" &&
            event.payload.summary === "The first oversized identity remains isolated.",
        );
        assert.equal(nestedProgress?.type, "task.progress");

        const secondLifecycle = taskEvents.filter(
          (event) => String(event.payload.taskId) === secondCanonicalTaskId,
        );
        assert.equal(secondLifecycle.length, 2);
        assert.deepEqual(
          secondLifecycle.map((event) => event.payload.subagent?.status),
          ["active", "failed"],
        );
        assert.equal(
          secondLifecycle.every(
            (event) => event.payload.subagent?.threadId === secondCanonicalTaskId,
          ),
          true,
        );

        const ordinaryLifecycle = taskEvents.filter(
          (event) => event.payload.taskId === RuntimeTaskId.make("ordinary-task-id"),
        );
        assert.equal(ordinaryLifecycle.length, 2);
        assert.equal(
          ordinaryLifecycle.every(
            (event) => event.payload.subagent?.threadId === "ordinary-task-id",
          ),
          true,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("emits ambient visibility while keeping skip_transcript task details hidden", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-ambient-1",
        tool_use_id: "tool-ambient-1",
        description: "Refreshing ambient account metadata",
        task_type: "housekeeping",
        skip_transcript: true,
        session_id: "sdk-session-ambient-task",
        uuid: "task-ambient-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-ambient-1",
        tool_use_id: "tool-ambient-1",
        description: "Refreshing ambient account metadata",
        usage: {
          total_tokens: 12,
          tool_uses: 1,
          duration_ms: 50,
        },
        session_id: "sdk-session-ambient-task",
        uuid: "task-ambient-progress",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "tool-ambient-1",
        session_id: "sdk-session-ambient-task",
        uuid: "task-ambient-assistant",
        message: {
          id: "task-ambient-assistant-message",
          role: "assistant",
          content: [{ type: "text", text: "Ambient task details must stay hidden." }],
          usage: {
            input_tokens: 12,
            output_tokens: 6,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-ambient-1",
        tool_use_id: "tool-ambient-1",
        status: "completed",
        output_file: "/tmp/ambient-output",
        summary: "Ambient refresh complete",
        session_id: "sdk-session-ambient-task",
        uuid: "task-ambient-completed",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const taskEvents = runtimeEvents.filter(
        (event) =>
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.completed",
      );
      assert.equal(taskEvents.length, 3);
      assert.equal(
        taskEvents.every((event) => event.payload.visibility === "ambient"),
        true,
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "turn.started"),
        false,
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.warning"),
        false,
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "content.delta"),
        false,
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("isolates forwarded subagent text, usage, and colliding tool block indexes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate the review",
        attachments: [],
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-reviewer-1",
        tool_use_id: "agent-tool-1",
        description: "Review the provider boundary",
        subagent_type: "code-reviewer",
        task_type: "subagent",
        session_id: "sdk-session-nested-agent",
        uuid: "task-started-nested-agent",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        parent_tool_use_id: null,
        session_id: "sdk-session-nested-agent",
        uuid: "main-tool-start",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "main-tool-1",
            name: "Read",
            input: { file_path: "main.ts" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        parent_tool_use_id: "agent-tool-1",
        session_id: "sdk-session-nested-agent",
        uuid: "nested-tool-start",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "nested-tool-1",
            name: "Read",
            input: { file_path: "nested.ts" },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        parent_tool_use_id: "agent-tool-1",
        subagent_type: "code-reviewer",
        task_description: "Review the provider boundary",
        session_id: "sdk-session-nested-agent",
        uuid: "nested-assistant-1",
        message: {
          id: "nested-message-1",
          role: "assistant",
          content: [{ type: "text", text: "The nested review found one lifecycle issue." }],
          usage: {
            input_tokens: 90_000,
            output_tokens: 2_000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        parent_tool_use_id: "agent-tool-1",
        session_id: "sdk-session-nested-agent",
        uuid: "nested-tool-result",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "nested-tool-1",
              content: "nested result",
              is_error: false,
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        parent_tool_use_id: null,
        session_id: "sdk-session-nested-agent",
        uuid: "main-tool-result",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "main-tool-1",
              content: "main result",
              is_error: false,
            },
          ],
        },
      } as unknown as SDKMessage);

      for (let index = 0; index < 8; index += 1) {
        yield* Effect.yieldNow;
      }

      const nestedProgress = runtimeEvents.find(
        (event) =>
          event.type === "task.progress" &&
          event.payload.taskId === RuntimeTaskId.make("task-reviewer-1"),
      );
      assert.equal(nestedProgress?.type, "task.progress");
      if (nestedProgress?.type === "task.progress") {
        assert.equal(nestedProgress.payload.description, "Review the provider boundary");
        assert.equal(
          nestedProgress.payload.summary,
          "The nested review found one lifecycle issue.",
        );
      }

      const completedToolIds = runtimeEvents
        .filter((event) => event.type === "item.completed")
        .map((event) => String(event.itemId))
        .toSorted();
      assert.deepEqual(completedToolIds, ["main-tool-1", "nested-tool-1"]);
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta.includes("nested review"),
        ),
        false,
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "thread.token-usage.updated"),
        false,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "shows an assistant-first subagent and lets its later task start replace the recovery title",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const taskEventsFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "task.progress" || event.type === "task.started",
        ).pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        // parent_tool_use_id is the SDK's explicit indication that this frame
        // came from a subagent. Older or reordered producers may deliver this
        // public child output before task_started and omit subagent_type.
        harness.query.emit({
          type: "assistant",
          parent_tool_use_id: "agent-tool-assistant-first",
          task_description: "Recovered child title",
          session_id: "sdk-session-assistant-first-subagent",
          uuid: "assistant-first-subagent-progress",
          message: {
            id: "assistant-first-subagent-message",
            role: "assistant",
            content: [{ type: "text", text: "The child has started its review." }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "assistant",
          parent_tool_use_id: "agent-tool-independent",
          task_description: "Independent child title",
          session_id: "sdk-session-assistant-first-subagent",
          uuid: "assistant-first-independent-progress",
          message: {
            id: "assistant-first-independent-message",
            role: "assistant",
            content: [{ type: "text", text: "The independent child is still working." }],
            usage: {
              input_tokens: 80,
              output_tokens: 16,
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-assistant-first",
          tool_use_id: "agent-tool-assistant-first",
          description: "Authoritative child title",
          task_type: "local_agent",
          session_id: "sdk-session-assistant-first-subagent",
          uuid: "assistant-first-subagent-started",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "assistant",
          parent_tool_use_id: "agent-tool-assistant-first",
          // A replayed assistant frame can retain the provisional description;
          // it must not roll the authoritative task_started title backward.
          task_description: "Recovered child title",
          session_id: "sdk-session-assistant-first-subagent",
          uuid: "assistant-first-subagent-late-progress",
          message: {
            id: "assistant-first-subagent-late-message",
            role: "assistant",
            content: [{ type: "text", text: "The child review is still active." }],
            usage: {
              input_tokens: 120,
              output_tokens: 24,
            },
          },
        } as unknown as SDKMessage);

        const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
        assert.deepEqual(
          taskEvents.map((event) => event.type),
          ["task.progress", "task.progress", "task.progress", "task.started", "task.progress"],
        );
        assert.deepEqual(
          taskEvents.map((event) => String(event.payload.taskId)),
          [
            "agent-tool-assistant-first",
            "agent-tool-independent",
            "agent-tool-assistant-first",
            "task-assistant-first",
            "task-assistant-first",
          ],
        );
        assert.deepEqual(
          taskEvents.map((event) => event.payload.visibility),
          ["visible", "visible", "ambient", "visible", "visible"],
        );
        assert.deepEqual(
          taskEvents.map((event) => event.payload.subagent?.label),
          [
            "Recovered child title",
            "Independent child title",
            "Recovered child title",
            "Authoritative child title",
            "Authoritative child title",
          ],
        );
        assert.equal(taskEvents[4]?.payload.description, "Authoritative child title");
        const owningTurnId = taskEvents[0]?.turnId;
        assert.ok(owningTurnId);
        assert.equal(
          taskEvents.every((event) => event.turnId === owningTurnId),
          true,
        );
        assert.equal(
          taskEvents.every((event) => event.payload.subagent?.historyId === undefined),
          true,
        );
        assert.equal(
          taskEvents.every(
            (event) =>
              event.payload.subagent === undefined ||
              (!("provisionalDescription" in event.payload.subagent) &&
                !("provisionalTaskIdentity" in event.payload.subagent) &&
                !("provisionalTaskId" in event.payload.subagent) &&
                !("provisionalToolUseKey" in event.payload.subagent) &&
                !("toolUseKey" in event.payload.subagent)),
          ),
          true,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "reconciles assistant-first aliases from exact progress and notification task identities",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const taskEventsFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.type === "task.progress" ||
            event.type === "task.started" ||
            event.type === "task.completed",
        ).pipe(Stream.take(6), Stream.runCollect, Effect.forkChild);

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        for (const [suffix, title] of [
          ["progress", "Recovered progress child"],
          ["notification", "Recovered notification child"],
        ] as const) {
          harness.query.emit({
            type: "assistant",
            parent_tool_use_id: `agent-tool-${suffix}`,
            task_description: title,
            session_id: "sdk-session-assistant-first-lifecycle",
            uuid: `assistant-first-${suffix}`,
            message: {
              id: `assistant-first-${suffix}-message`,
              role: "assistant",
              content: [{ type: "text", text: `${title} is active.` }],
              usage: { input_tokens: 50, output_tokens: 10 },
            },
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-authoritative-progress",
          tool_use_id: "agent-tool-progress",
          description: "Authoritative progress child",
          summary: "Reviewing the exact task identity.",
          usage: { total_tokens: 100, tool_uses: 1, duration_ms: 500 },
          session_id: "sdk-session-assistant-first-lifecycle",
          uuid: "assistant-first-authoritative-progress",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-authoritative-notification",
          tool_use_id: "agent-tool-notification",
          status: "completed",
          output_file: "/tmp/assistant-first-notification",
          summary: "Notification child completed.",
          session_id: "sdk-session-assistant-first-lifecycle",
          uuid: "assistant-first-authoritative-notification",
        } as unknown as SDKMessage);

        const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
        assert.deepEqual(
          taskEvents.map((event) => [
            event.type,
            String(event.payload.taskId),
            event.payload.visibility,
            event.payload.subagent?.label,
          ]),
          [
            ["task.progress", "agent-tool-progress", "visible", "Recovered progress child"],
            ["task.progress", "agent-tool-notification", "visible", "Recovered notification child"],
            ["task.progress", "agent-tool-progress", "ambient", "Recovered progress child"],
            [
              "task.progress",
              "task-authoritative-progress",
              "visible",
              "Authoritative progress child",
            ],
            ["task.progress", "agent-tool-notification", "ambient", "Recovered notification child"],
            [
              "task.completed",
              "task-authoritative-notification",
              "visible",
              "Recovered notification child",
            ],
          ],
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("keeps Claude task progress usage out of context window updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const taskEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress" || event.type === "thread.token-usage.updated",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const taskEvents = Array.from(yield* Fiber.join(taskEventFiber));
      const progressEvent = taskEvents[0];
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.deepEqual(progressEvent.payload.usage, {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "uses Claude message usage for the live context window and result totals for throughput",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const modelSelection = createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "1m" }],
        );

        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        runtimeEvents.length = 0;

        harness.query.emit({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              model: "claude-fable-5",
              id: "msg-fable-live-usage",
              type: "message",
              role: "assistant",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              stop_details: null,
              usage: {
                input_tokens: 2,
                cache_creation_input_tokens: 395_871,
                cache_read_input_tokens: 15_939,
                output_tokens: 3,
                cache_creation: {
                  ephemeral_5m_input_tokens: 0,
                  ephemeral_1h_input_tokens: 395_871,
                },
                service_tier: "standard",
              },
            },
          },
          session_id: "sdk-session-fable-live-usage",
          parent_tool_use_id: null,
          uuid: "stream-fable-live-usage",
          ttft_ms: 10,
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-fable-subagent-usage",
          description: "Background subagent progress",
          usage: {
            total_tokens: 9_093,
            tool_uses: 1,
            duration_ms: 1_991,
          },
          session_id: "sdk-session-fable-live-usage",
          uuid: "task-fable-subagent-usage",
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 2,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-fable-live-usage",
          usage: {
            input_tokens: 400,
            cache_creation_input_tokens: 788_309,
            cache_read_input_tokens: 31_878,
            output_tokens: 1_396,
          },
          modelUsage: {
            "claude-fable-5": {
              contextWindow: 1_000_000,
              maxOutputTokens: 64_000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const usageEvents = runtimeEvents.filter(
          (event) => event.type === "thread.token-usage.updated",
        );
        assert.equal(usageEvents.length, 2);

        const liveUsageEvent = usageEvents[0];
        assert.equal(liveUsageEvent?.type, "thread.token-usage.updated");
        if (liveUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(liveUsageEvent.payload, {
            usage: {
              usedTokens: 411_815,
              lastUsedTokens: 411_815,
              inputTokens: 411_812,
              cachedInputTokens: 15_939,
              cacheWriteInputTokens: 395_871,
              outputTokens: 3,
              reasoningOutputTokens: 0,
              lastReasoningOutputTokens: 0,
              maxTokens: 1_000_000,
            },
          });
        }

        const finalUsageEvent = usageEvents.at(-1);
        assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
        if (finalUsageEvent?.type === "thread.token-usage.updated") {
          assert.deepEqual(finalUsageEvent.payload, {
            usage: {
              usedTokens: 411_815,
              lastUsedTokens: 411_815,
              totalProcessedTokens: 821_983,
              inputTokens: 411_812,
              cachedInputTokens: 15_939,
              cacheWriteInputTokens: 395_871,
              outputTokens: 3,
              reasoningOutputTokens: 0,
              lastReasoningOutputTokens: 0,
              maxTokens: 1_000_000,
            },
          });
        }

        assert.equal(
          usageEvents.some(
            (event) =>
              event.type === "thread.token-usage.updated" &&
              event.payload.usage.usedTokens === 9_093,
          ),
          false,
        );

        runtimeEventsFiber.interruptUnsafe();
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("maps Claude task_updated patches without runtime warnings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-update-running",
        patch: {
          status: "running",
          summary: "Background agent is checking imports.",
        },
        session_id: "sdk-session-task-updated",
        uuid: "task-update-running-1",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-update-completed",
        patch: {
          status: "completed",
          end_time: 1_781_176_454_986,
        },
        session_id: "sdk-session-task-updated",
        uuid: "task-update-completed-1",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const progressEvent = runtimeEvents.find(
        (event) =>
          event.type === "task.progress" &&
          event.payload.taskId === RuntimeTaskId.make("task-update-running"),
      );
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(progressEvent.payload.description, "Task running");
        assert.equal(progressEvent.payload.summary, "Background agent is checking imports.");
      }

      const completedEvent = runtimeEvents.find(
        (event) =>
          event.type === "task.completed" &&
          event.payload.taskId === RuntimeTaskId.make("task-update-completed"),
      );
      assert.equal(completedEvent?.type, "task.completed");
      if (completedEvent?.type === "task.completed") {
        assert.equal(completedEvent.payload.status, "completed");
      }

      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.warning"),
        false,
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports a requested Claude fast-mode fallback once per upstream status", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      const fastModeFallback = {
        type: "system",
        subtype: "init",
        fast_mode_state: "off",
        fast_mode_disabled_reason: "sdk_opt_in_required",
        capabilities: [],
        session_id: "sdk-session-fast-mode",
        uuid: "fast-mode-fallback",
      } as unknown as SDKMessage;
      harness.query.emit(fastModeFallback);
      harness.query.emit({
        ...fastModeFallback,
        uuid: "fast-mode-fallback-duplicate",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 1);
      const warning = warnings[0];
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.equal(
          warning.payload.message,
          "Claude could not activate the requested fast mode; this session is continuing at standard speed.",
        );
        assert.deepEqual(warning.payload.detail, {
          fastModeState: "off",
          fastModeDisabledReason: "sdk_opt_in_required",
        });
      }

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps progress heartbeats quiet and surfaces each subagent retry once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run the delegated task",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-subagent-retry",
        uuid: "stream-subagent-retry-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-subagent-retry-thread",
          },
        },
      } as unknown as SDKMessage);
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const progressEventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "tool_progress",
        tool_use_id: "tool-heartbeat-1",
        tool_name: "Agent",
        parent_tool_use_id: null,
        elapsed_time_seconds: 30,
        heartbeat: true,
        session_id: "sdk-session-subagent-retry",
        uuid: "00000000-0000-4000-8000-000000000221",
      } satisfies SDKMessage);
      const retryMessage = {
        type: "tool_progress",
        tool_use_id: "tool-retry-1",
        tool_name: "Agent",
        parent_tool_use_id: null,
        elapsed_time_seconds: 31,
        task_id: "task-retry-1",
        subagent_type: "code-reviewer",
        subagent_retry: {
          agent_id: "agent-retry-1",
          attempt: 2,
          max_retries: 3,
          retry_delay_ms: 500,
          error_status: 529,
          error_category: "overloaded",
        },
        session_id: "sdk-session-subagent-retry",
        uuid: "00000000-0000-4000-8000-000000000222",
      } satisfies SDKMessage;
      harness.query.emit(retryMessage);
      harness.query.emit({
        ...retryMessage,
        uuid: "00000000-0000-4000-8000-000000000223",
      });

      const progressEvents = Array.from(yield* Fiber.join(progressEventsFiber));
      assert.equal(progressEvents.filter((event) => event.type === "tool.progress").length, 3);
      const retryEvents = progressEvents.filter((event) => event.type === "task.progress");
      assert.equal(retryEvents.length, 1);
      const retryEvent = retryEvents[0];
      assert.equal(retryEvent?.type, "task.progress");
      if (retryEvent?.type === "task.progress") {
        assert.equal(retryEvent.payload.taskId, RuntimeTaskId.make("task-retry-1"));
        assert.equal(retryEvent.payload.subagent?.label, "Code reviewer");
        assert.equal(
          retryEvent.payload.summary,
          "Retrying code-reviewer subagent after overloaded (retry 2/3, 500 ms delay).",
        );
        assert.equal(retryEvent.payload.lastToolName, "Agent");
      }

      const startedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.started",
      ).pipe(Stream.runHead, Effect.forkChild);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-retry-1",
        tool_use_id: "tool-retry-1",
        description: "Audit retry title stability",
        subagent_type: "code-reviewer",
        task_type: "local_agent",
        session_id: "sdk-session-subagent-retry",
        uuid: "00000000-0000-4000-8000-000000000224",
      } as unknown as SDKMessage);
      const started = yield* Fiber.join(startedFiber);
      assert.equal(started._tag, "Some");
      if (started._tag === "Some" && started.value.type === "task.started") {
        assert.equal(started.value.payload.subagent?.label, "Audit retry title stability");
      }

      const stableRetryFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.progress",
      ).pipe(Stream.runHead, Effect.forkChild);
      harness.query.emit({
        ...retryMessage,
        elapsed_time_seconds: 32,
        subagent_retry: {
          ...retryMessage.subagent_retry,
          attempt: 3,
        },
        uuid: "00000000-0000-4000-8000-000000000225",
      });
      const stableRetry = yield* Fiber.join(stableRetryFiber);
      assert.equal(stableRetry._tag, "Some");
      if (stableRetry._tag === "Some" && stableRetry.value.type === "task.progress") {
        assert.equal(stableRetry.value.payload.subagent?.label, "Audit retry title stability");
        assert.equal(
          stableRetry.value.payload.description,
          "Retrying code-reviewer subagent after overloaded (retry 3/3, 500 ms delay).",
        );
        assert.equal(stableRetry.value.payload.summary, stableRetry.value.payload.description);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "forwards repeated quota updates and no-response retries without ending the turn",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "continue while the provider retries",
          attachments: [],
        });
        const telemetryFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "account.rate-limits.updated" || event.type === "runtime.warning",
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        const rateLimitInfo = {
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
          resetsAt: 1800000000,
        };
        // SDK 0.3.260 re-emits the same exceeded window during repeated 429s.
        // Both observations must reach the provider-status consumer.
        for (const uuid of ["quota-first", "quota-repeat"]) {
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: rateLimitInfo,
            session_id: "claude-current-telemetry",
            uuid,
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 1,
          retry_delay_ms: 500,
          error_status: null,
          error: "server_error",
          no_response: { waited_ms: 180000, retry_wait_ms: 600000 },
          session_id: "claude-current-telemetry",
          uuid: "no-response-retry",
        } as unknown as SDKMessage);
        const events = Array.from(yield* Fiber.join(telemetryFiber));
        assert.equal(
          events.filter((event) => event.type === "account.rate-limits.updated").length,
          2,
        );
        const warning = events.find((event) => event.type === "runtime.warning");
        assert.equal(warning?.payload.message, "Claude reported an API retry.");
        assert.deepInclude(warning?.payload.detail, {
          no_response: { waited_ms: 180000, retry_wait_ms: 600000 },
        });
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
        assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("silently ignores Claude thinking token telemetry", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      harness.query.emit({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 50,
        estimated_tokens_delta: 50,
        session_id: "sdk-session-thinking-tokens",
        uuid: "thinking-tokens-1",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" || event.type === "thread.token-usage.updated",
        ),
        false,
      );

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-after-thinking-tokens",
        description: "Visible work",
        session_id: "sdk-session-thinking-tokens",
        uuid: "task-after-thinking-tokens",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.equal(
        runtimeEvents.some((event) => event.type === "task.started"),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" || event.type === "thread.token-usage.updated",
        ),
        false,
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles current Claude SDK system messages without generic warnings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      harness.query.emit({
        type: "system",
        subtype: "commands_changed",
        commands: [],
        session_id: "sdk-session-191",
        uuid: "commands-changed-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "background-task-204",
            task_type: "agent",
            description: "Indexing repository context",
          },
        ],
        session_id: "sdk-session-204",
        uuid: "background-tasks-changed-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "informational",
        content: "Slash command output was rendered.",
        level: "info",
        session_id: "sdk-session-191",
        uuid: "informational-info-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "low",
        text: "Background notification",
        priority: "low",
        session_id: "sdk-session-191",
        uuid: "notification-low-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "prompt_suggestion",
        suggestion: "What should I do next?",
        session_id: "sdk-session-191",
        uuid: "prompt-suggestion-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "control_request_progress",
        status: "api_retry",
        attempt: 2,
        max_retries: 3,
        retry_delay_ms: 500,
        request_id: "control-progress-198",
        session_id: "sdk-session-198",
        uuid: "control-progress-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "conversation_reset",
        reason: "remote_reset",
        session_id: "sdk-session-198",
        uuid: "conversation-reset-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "active_goal",
        id: "goal-198",
        objective: "Finish the requested implementation.",
        session_id: "sdk-session-198",
        uuid: "active-goal-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "post_turn_summary",
        status_category: "review_ready",
        status_detail: "Implemented the requested parser fix",
        needs_action: "Review the diff",
        summarizes_uuid: "assistant-198",
        session_id: "sdk-session-198",
        uuid: "post-turn-summary-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_summary",
        detail: "Explored the repository layout",
        session_id: "sdk-session-198",
        uuid: "task-summary-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "session_state_changed",
        state: "running",
        session_id: "sdk-session-191",
        uuid: "session-state-running-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "worker_shutting_down",
        reason: "host_exit",
        session_id: "sdk-session-191",
        uuid: "worker-shutting-down-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        scope: "session",
        original_model: "claude-fable-5",
        fallback_model: "claude-sonnet-4-5",
        request_id: "req-191",
        api_refusal_category: "cyber",
        api_refusal_explanation: "Refusal category explanation.",
        retracted_message_uuids: ["retracted-1"],
        content: "Claude retried the turn on a fallback model after a model refusal.",
        session_id: "sdk-session-191",
        uuid: "model-refusal-fallback-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "claude-fable-5",
        request_id: "req-195",
        api_refusal_category: "cyber",
        api_refusal_explanation: "Refusal category explanation.",
        refused_user_message_uuid: "user-message-195",
        content: "Claude refused the turn and no fallback model was configured.",
        session_id: "sdk-session-195",
        uuid: "model-refusal-no-fallback-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "informational",
        content: "Continuation was blocked by a hook.",
        level: "warning",
        prevent_continuation: true,
        session_id: "sdk-session-191",
        uuid: "informational-warning-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "immediate",
        text: "Immediate provider notification",
        priority: "immediate",
        timeout_ms: 5000,
        session_id: "sdk-session-191",
        uuid: "notification-immediate-1",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message.startsWith("Unhandled Claude"),
        ),
        false,
      );
      const runningState = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.reason === "session_state_changed:running",
      );
      assert.equal(runningState?.type, "session.state.changed");
      if (runningState?.type === "session.state.changed") {
        assert.equal(runningState.payload.state, "running");
      }

      const workerState = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.reason === "worker_shutting_down:host_exit",
      );
      assert.equal(workerState?.type, "session.state.changed");
      if (workerState?.type === "session.state.changed") {
        assert.equal(workerState.payload.state, "waiting");
      }

      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "tool.progress" &&
            event.payload.summary === "Implemented the requested parser fix — Review the diff",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "tool.progress" &&
            event.payload.summary === "Explored the repository layout",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "tool.progress" &&
            event.payload.summary === "Claude control request retry 2/3 in 500 ms.",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "task.progress" &&
            event.payload.taskId === RuntimeTaskId.make("goal-198"),
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "task.progress" &&
            event.payload.taskId === RuntimeTaskId.make("background-task-204") &&
            event.payload.description === "Indexing repository context",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "active",
        ),
        true,
      );

      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" && event.payload.message.includes("fallback model"),
        ),
        true,
      );
      const fallbackWarning = runtimeEvents.find(
        (event) =>
          event.type === "runtime.warning" && event.payload.message.includes("fallback model"),
      );
      assert.equal(fallbackWarning?.type, "runtime.warning");
      if (fallbackWarning?.type === "runtime.warning") {
        assert.equal(
          (fallbackWarning.payload.detail as Record<string, unknown> | undefined)?.scope,
          "session",
        );
      }
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message ===
              "Claude refused the turn and no fallback model was configured.",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message === "Continuation was blocked by a hook.",
        ),
        true,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message === "Immediate provider notification",
        ),
        true,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude VCS changes and quietly accepts current host-only frames", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEvents.length = 0;

      harness.query.emit({
        type: "system",
        subtype: "vcs_state_changed",
        kind: "commit",
        branch: "main",
        cwd: "/untrusted/provider/path",
        session_id: "sdk-session-vcs",
        uuid: "vcs-state-changed-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "code_change_published",
        provider: "github",
        url: "https://example.invalid/private/change/42",
        repo: "cafeai/cafe-code",
        identifier: "#42",
        action: "published",
        session_id: "sdk-session-vcs",
        uuid: "code-change-published-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "feedback_draft_queued",
        draft_type: "idea",
        summary: "Private draft summary",
        details_preview: "Private draft details",
        session_id: "sdk-session-vcs",
        uuid: "feedback-draft-queued-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "autocompact_state",
        state: "eligible",
        session_id: "sdk-session-vcs",
        uuid: "autocompact-state-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "transcript_mirror",
        filePath: "/untrusted/provider/transcript.jsonl",
        entries: [],
        session_id: "sdk-session-vcs",
        uuid: "transcript-mirror-1",
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const vcsEvent = runtimeEvents.find((event) => event.type === "vcs.state.changed");
      assert.equal(vcsEvent?.type, "vcs.state.changed");
      if (vcsEvent?.type === "vcs.state.changed") {
        assert.deepEqual(vcsEvent.payload, { kind: "commit", branch: "main" });
        assert.equal(
          (JSON.stringify(vcsEvent.raw) ?? "").includes("/untrusted/provider/path"),
          false,
        );
      }

      const publicationEvent = runtimeEvents.find(
        (event) =>
          event.type === "tool.progress" &&
          event.payload.summary === "Claude published a code change #42 in cafeai/cafe-code.",
      );
      assert.equal(publicationEvent?.type, "tool.progress");
      assert.equal(
        (JSON.stringify(publicationEvent?.raw) ?? "").includes("https://example.invalid"),
        false,
      );
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message.startsWith("Unhandled Claude"),
        ),
        false,
      );

      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits deduplicated billing snapshots independently of context and starts a new accounting scope on reset",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const observed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "thread.usage-accounting.updated"),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        const emitAssistant = (id: string, input: number) =>
          harness.query.emit({
            type: "assistant",
            uuid: `sdk-${id}`,
            parent_tool_use_id: null,
            session_id: "sdk-billing-session",
            message: {
              id,
              model: "claude-sonnet-5",
              role: "assistant",
              content: [],
              usage: {
                input_tokens: input,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                output_tokens: 0,
              },
            },
          } as unknown as SDKMessage);
        const emitResult = (input: number, output: number) =>
          harness.query.emit({
            type: "result",
            subtype: "success",
            is_error: false,
            uuid: `result-${input}`,
            session_id: "sdk-billing-session",
            result: "done",
            stop_reason: "end_turn",
            num_turns: 1,
            duration_ms: 1,
            duration_api_ms: 1,
            usage: {
              input_tokens: input,
              output_tokens: output,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage: {
              "claude-sonnet-5": {
                inputTokens: input,
                outputTokens: output,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            },
          } as unknown as SDKMessage);
        emitAssistant("api-a", 100000);
        emitAssistant("api-a", 100000);
        emitAssistant("api-b", 101000);
        emitResult(201000, 100);
        harness.query.emit({
          type: "conversation_reset",
          new_conversation_id: "30000000-0000-4000-8000-000000000000",
          session_id: "sdk-billing-session",
          uuid: "40000000-0000-4000-8000-000000000000",
        } as SDKMessage);
        emitResult(300000, 200);
        const events = yield* Fiber.join(observed);
        const snapshots = events.map((event) => event.payload);
        assert.deepEqual(
          snapshots.map((snapshot) => snapshot.models[0]?.inputTokens),
          [100000, 201000, 201000, 300000],
        );
        assert.deepEqual(
          snapshots.map((snapshot) => snapshot.models[0]?.outputTokens),
          [0, 0, 100, 200],
        );
        assert.equal(snapshots[0]?.scopeId, snapshots[2]?.scopeId);
        assert.notEqual(snapshots[0]?.scopeId, snapshots[3]?.scopeId);
        assert.equal(snapshots[3]?.revision, 1);
        assert.equal(JSON.stringify(snapshots).includes("sdk-billing-session"), false);
        assert.equal(JSON.stringify(snapshots).includes("api-a"), false);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  for (const cliVersion of ["2.1.278", "2.1.274"]) {
    it.effect(`separates resumed Claude usage from saved history on CLI ${cliVersion}`, () => {
      const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-accounting-resume-"));
      const cwd = path.join(homePath, "workspace");
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const project = claudeProjectDirectoryForTest(homePath, cwd);
      mkdirSync(project, { recursive: true });
      const model = "claude-sonnet-5";
      const totals = (inputTokens: number, outputTokens: number) => ({
        [model]: {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      });
      writeFileSync(
        path.join(project, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "cost-state",
          sessionId,
          modelUsage: totals(1000, 100),
        }) + "\n",
        { mode: 0o600 },
      );
      const harness = makeHarness({
        cwd,
        claudeConfig: { homePath },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: undefined },
      });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        const observed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "thread.usage-accounting.updated"),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          cwd,
          resumeCursor: { resume: sessionId, turnCount: 1 },
        });
        assert.equal(harness.getLastCreateQueryInput()?.options.resume, sessionId);
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "new input", attachments: [] });
        harness.query.emit({
          type: "system",
          subtype: "init",
          claude_code_version: cliVersion,
          session_id: sessionId,
          uuid: "init-usage",
          capabilities: [],
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "assistant",
          uuid: "new-assistant",
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            id: "new-api-request",
            model: "claude-sonnet-5",
            content: [],
            usage: {
              input_tokens: 100,
              output_tokens: 999,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        } as unknown as SDKMessage);
        const emitResult = (modelUsage: ReturnType<typeof totals>) =>
          harness.query.emit({
            type: "result",
            subtype: "success",
            is_error: false,
            uuid: "new-result",
            session_id: sessionId,
            result: "done",
            stop_reason: "end_turn",
            num_turns: 1,
            duration_ms: 1,
            duration_api_ms: 1,
            usage: {
              input_tokens: 200,
              output_tokens: 20,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage,
          } as unknown as SDKMessage);
        emitResult(cliVersion === "2.1.278" ? totals(1200, 120) : totals(200, 20));
        harness.query.emit({
          type: "conversation_reset",
          new_conversation_id: "30000000-0000-4000-8000-000000000000",
          session_id: sessionId,
          uuid: "40000000-0000-4000-8000-000000000000",
        } as SDKMessage);
        emitResult(totals(300, 30));
        const snapshots = (yield* Fiber.join(observed)).map((event) => event.payload);
        assert.deepEqual(
          snapshots.map((snapshot) => snapshot.models[0]?.inputTokens),
          [100, 200, 300],
        );
        assert.deepEqual(
          snapshots.map((snapshot) => snapshot.models[0]?.outputTokens),
          [0, 20, 30],
        );
        assert.deepEqual(
          snapshots.map((snapshot) => snapshot.completeness),
          ["input-only", "complete", "complete"],
        );
        assert.equal(snapshots[0]?.scopeId, snapshots[1]?.scopeId);
        assert.notEqual(snapshots[1]?.scopeId, snapshots[2]?.scopeId);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
          output_tokens_details: {
            thinking_tokens: 740,
          },
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
            // Cumulative main-loop reasoning. It is already a subset of this
            // model's output and must not inflate `outputTokens` below.
            thinkingTokens: 900,
          },
          "claude-haiku-4-5": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
            // ModelUsage includes query-pipeline sidechains/subagents that the
            // result.usage main-loop aggregate intentionally excludes.
            thinkingTokens: 100,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            cachedInputTokens: 21144,
            cacheWriteInputTokens: 2715,
            outputTokens: 679,
            reasoningOutputTokens: 679,
            lastReasoningOutputTokens: 679,
            totalReasoningOutputTokens: 1000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits explicit output and reasoning resets for each Claude message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const usageEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "thread.token-usage.updated",
      ).pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "exercise two message counters",
        attachments: [],
      });

      for (const message of [
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
          session_id: "sdk-session-reasoning-reset",
          uuid: "reasoning-reset-start-1",
          parent_tool_use_id: null,
        },
        {
          type: "stream_event",
          event: {
            type: "message_delta",
            usage: {
              output_tokens: 100,
              output_tokens_details: { thinking_tokens: 40 },
            },
          },
          session_id: "sdk-session-reasoning-reset",
          uuid: "reasoning-reset-delta-1",
          parent_tool_use_id: null,
        },
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 20, output_tokens: 0 } },
          },
          session_id: "sdk-session-reasoning-reset",
          uuid: "reasoning-reset-start-2",
          parent_tool_use_id: null,
        },
        {
          type: "stream_event",
          event: {
            type: "message_delta",
            usage: {
              output_tokens: 150,
              output_tokens_details: { thinking_tokens: 60 },
            },
          },
          session_id: "sdk-session-reasoning-reset",
          uuid: "reasoning-reset-delta-2",
          parent_tool_use_id: null,
        },
      ]) {
        harness.query.emit(message as unknown as SDKMessage);
      }

      const usageEvents = Array.from(yield* Fiber.join(usageEventsFiber));
      assert.deepEqual(
        usageEvents.map((event) => ({
          outputTokens: event.payload.usage.outputTokens,
          reasoningOutputTokens: event.payload.usage.reasoningOutputTokens,
          lastReasoningOutputTokens: event.payload.usage.lastReasoningOutputTokens,
        })),
        [
          { outputTokens: 0, reasoningOutputTokens: 0, lastReasoningOutputTokens: 0 },
          { outputTokens: 100, reasoningOutputTokens: 40, lastReasoningOutputTokens: 40 },
          { outputTokens: 0, reasoningOutputTokens: 0, lastReasoningOutputTokens: 0 },
          { outputTokens: 150, reasoningOutputTokens: 60, lastReasoningOutputTokens: 60 },
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the selected Claude context window over conflicting model usage metadata", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-7",
        [{ id: "contextWindow", value: "200k" }],
      );

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        modelSelection,
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-selected-window",
        usage: {
          total_tokens: 250000,
        },
        modelUsage: {
          "claude-opus-4-7[1m]": {
            contextWindow: 1000000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 250000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not let Claude task progress snapshots override result context totals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "thread.token-usage.updated" || event.type === "turn.completed",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-clamped",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 190000,
        },
        session_id: "sdk-session-task-usage-clamped",
        uuid: "task-usage-progress-clamped",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped-after-progress",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageEvents.length, 1);
      const finalUsageEvent = usageEvents.at(-1);
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "repairs each completed Claude block without conflating wrapper and API identities",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        let sequence = 0;
        const stream = (event: unknown) =>
          harness.query.emit({
            type: "stream_event",
            session_id: "sdk-block-snapshots",
            uuid: `stream-${sequence++}`,
            parent_tool_use_id: null,
            event,
          } as SDKMessage);
        const snapshot = (uuid: string, id: string, text: string) =>
          harness.query.emit({
            type: "assistant",
            session_id: "sdk-block-snapshots",
            uuid,
            parent_tool_use_id: null,
            message: { id, content: [{ type: "text", text }] },
          } as SDKMessage);
        stream({ type: "message_start", message: { id: "api-one" } });
        for (const [index, prefix, full] of [
          [0, "First paragraph.", "First paragraph."],
          [1, "The", "The second paragraph.\n"],
          [2, "", "Third paragraph without deltas."],
          [3, "\ud83d", "\ud83d\ude00 split surrogate remains exact."],
        ] as const) {
          stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
          if (prefix)
            stream({
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: prefix },
            });
          // Each frame carries only its own block, even with the same message.id.
          snapshot(`wrapper-${index}`, "api-one", full);
          snapshot(`wrapper-${index}`, "api-one", full);
          stream({ type: "content_block_stop", index });
        }
        stream({ type: "message_stop" });
        stream({ type: "message_start", message: { id: "api-two" } });
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "The" },
        });
        snapshot("wrapper-next-api", "api-two", "The next API message.");
        stream({ type: "content_block_stop", index: 0 });
        harness.query.emit(makeSuccessfulClaudeResult("sdk-block-snapshots"));
        const events = Array.from(yield* Fiber.join(collected));
        const textByItem = new Map<string, string>();
        for (const event of events) {
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
            const key = String(event.itemId);
            textByItem.set(key, (textByItem.get(key) ?? "") + event.payload.delta);
          }
        }
        assert.deepEqual(
          [...textByItem.values()],
          [
            "First paragraph.",
            "The second paragraph.\n",
            "Third paragraph without deltas.",
            "\ud83d\ude00 split surrogate remains exact.",
            "The next API message.",
          ],
        );
        const completions = events.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        );
        assert.equal(completions.length, 5);
        assert.deepEqual(
          completions.map((event) => event.payload.detail),
          [...textByItem.values()],
        );
        assert.equal(
          events.some((event) => event.type === "runtime.warning"),
          false,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "does not repair Claude text from a different native message or a nonmatching prefix",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        let sequence = 0;
        const stream = (event: unknown) =>
          harness.query.emit({
            type: "stream_event",
            session_id: "sdk-safe-blocks",
            uuid: `stream-${sequence++}`,
            parent_tool_use_id: null,
            event,
          } as SDKMessage);
        const snapshot = (uuid: string, id: string, text: string) =>
          harness.query.emit({
            type: "assistant",
            session_id: "sdk-safe-blocks",
            uuid,
            parent_tool_use_id: null,
            message: { id, content: [{ type: "text", text }] },
          } as SDKMessage);
        // Distinct invalid Unicode code units must remain distinct identities;
        // UTF-8 replacement would incorrectly collapse both to U+FFFD.
        stream({ type: "message_start", message: { id: "api-\ud800" } });
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "The" },
        });
        snapshot("wrapper-\ud800", "api-\ud801", "The unrelated message.");
        snapshot("wrapper-\ud801", "api-\ud800", "The original message.");
        stream({ type: "content_block_stop", index: 0 });
        stream({
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        });
        stream({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Preserved prefix" },
        });
        snapshot("wrapper-conflict", "api-\ud800", "Unrelated replacement must not overwrite");
        stream({ type: "content_block_stop", index: 1 });
        harness.query.emit(makeSuccessfulClaudeResult("sdk-safe-blocks"));
        const events = Array.from(yield* Fiber.join(collected));
        const textByItem = new Map<string, string>();
        for (const event of events) {
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
            const key = String(event.itemId);
            textByItem.set(key, (textByItem.get(key) ?? "") + event.payload.delta);
          }
        }
        assert.deepEqual(
          [...textByItem.values()],
          ["The original message.", "The unrelated message.", "Preserved prefix"],
        );
        const warnings = events.filter((event) => event.type === "runtime.warning");
        assert.equal(warnings.length, 1);
        assert.equal(JSON.stringify(warnings).includes("Unrelated replacement"), false);
        assert.equal(JSON.stringify(warnings).includes("Preserved prefix"), false);
        assert.equal(
          events.filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          ).length,
          3,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps accept-for-session permission updates strictly session-scoped", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
            {
              type: "addDirectories",
              directories: ["/persistent-local-path"],
              destination: "localSettings",
            },
            {
              type: "setMode",
              mode: "plan",
              destination: "userSettings",
            },
          ],
          toolUseID: "tool-use-1",
          requestId: "permission-request-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "acceptForSession",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "acceptForSession");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult as PermissionResult, {
        behavior: "allow",
        updatedInput: { command: "pwd" },
        updatedPermissions: [
          {
            type: "setMode",
            mode: "default",
            destination: "session",
          },
        ],
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("enforces provider one-time-only approval hints even for older clients", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.ok(canUseTool);
      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          toolUseID: "sensitive-tool",
          requestId: "sensitive-request",
          defaultToNo: true,
          suppressAlwaysAllowRule: true,
          suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
        },
      );
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "request.opened") return;
      assert.equal(requested.value.payload.defaultToNo, true);
      assert.equal(requested.value.payload.suppressAlwaysAllowRule, true);
      const requestId = ApprovalRequestId.make(requested.value.requestId!);
      const rejected = yield* adapter
        .respondToRequest(session.threadId, requestId, "acceptForSession")
        .pipe(Effect.flip);
      assert.match(rejected.message, /one-time decision/);
      // Rejection must leave the same request actionable, never silently grant
      // broader rights or force the caller to replay the original tool call.
      yield* adapter.respondToRequest(session.threadId, requestId, "accept");
      const permission = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permission, { behavior: "allow", updatedInput: { command: "pwd" } });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("honors rule-forced Claude approvals even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-rule-forced-1",
          requestId: "permission-rule-forced-1",
          matchedAskRule: {
            source: "projectSettings",
            toolName: "Bash",
            ruleContent: "Bash(pwd) private-policy-fragment",
          },
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
        return;
      }
      assert.equal(
        requested.value.payload.detail,
        "Permission rule requires confirmation. Bash: pwd",
      );
      assert.deepEqual(requested.value.payload.args, {
        toolName: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-rule-forced-1",
        matchedAskRule: true,
      });
      assert.deepEqual(requested.value.raw?.payload, {
        toolName: "Bash",
        input: { command: "pwd" },
        matchedAskRule: true,
      });

      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }
      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );
      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      assert.equal(resolved._tag === "Some" ? resolved.value.type : undefined, "request.resolved");

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("surfaces an Auto-mode fallback prompt instead of bypassing the classifier", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        interactionMode: "auto",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "deploy-production" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-auto-fallback-1",
          requestId: "permission-auto-fallback-1",
        },
      );
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
        return;
      }

      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }
      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "decline",
      );
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
          requestId: "permission-request-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
          requestId: "permission-request-grep-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without SDK checkpoint options for normal follow-ups", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "approval-required",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
      assert.equal(createInput?.options.permissionMode, "default");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops a durable Claude resume cursor when the cwd transcript is missing", () => {
    const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-missing-resume-home-"));
    const cwd = path.join(homePath, "workspace");
    const harness = makeHarness({
      cwd,
      claudeConfig: { homePath },
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(homePath, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const missingSessionId = "550e8400-e29b-41d4-a716-446655440000";

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        title: "Recovered Cafe task",
        cwd,
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: missingSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(session.resumeCursor, undefined);
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.title, "Recovered Cafe task");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "repairs a corrupted Claude resume session id from the stored assistant checkpoint",
    () => {
      const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-repair-resume-home-"));
      const cwd = path.join(homePath, "workspace");
      const staleSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const repairedSessionId = "550e8400-e29b-41d4-a716-446655440001";
      const assistantUuid = "assistant-99";
      const projectDirectory = claudeProjectDirectoryForTest(homePath, cwd);
      mkdirSync(projectDirectory, { recursive: true });
      writeFileSync(
        path.join(projectDirectory, `${repairedSessionId}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          uuid: assistantUuid,
          session_id: repairedSessionId,
        })}\n`,
      );

      const harness = makeHarness({
        cwd,
        claudeConfig: { homePath },
      });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            rmSync(homePath, {
              recursive: true,
              force: true,
            }),
          ),
        );

        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd,
          resumeCursor: {
            threadId: RESUME_THREAD_ID,
            resume: staleSessionId,
            resumeSessionAt: assistantUuid,
            turnCount: 3,
          },
          runtimeMode: "full-access",
        });

        const createInput = harness.getLastCreateQueryInput();
        assert.deepEqual(session.resumeCursor, {
          threadId: RESUME_THREAD_ID,
          resume: repairedSessionId,
          turnCount: 3,
        });
        assert.equal(createInput?.options.resume, repairedSessionId);
        assert.equal(createInput?.options.resumeSessionAt, undefined);
        assert.equal(createInput?.options.sessionId, undefined);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("passes a durable Claude resume cursor when the cwd transcript exists", () => {
    const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-present-resume-home-"));
    const cwd = path.join(homePath, "workspace");
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const projectDirectory = claudeProjectDirectoryForTest(homePath, cwd);
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(path.join(projectDirectory, `${sessionId}.jsonl`), "{}\n");

    const harness = makeHarness({
      cwd,
      claudeConfig: { homePath },
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(homePath, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        title: "Do not replace the persisted native title",
        cwd,
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: sessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: sessionId,
        turnCount: 3,
      });
      assert.equal(createInput?.options.resume, sessionId);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.title, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const selectedIndex of [0, 1, 2, 4]) {
    it.effect(
      `forks exact selected Claude message ${selectedIndex} inclusively after restart without changing the source`,
      () => {
        const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-selected-fork-"));
        const cwd = path.join(homePath, "workspace");
        const sessionId = "76000000-0000-4000-8000-000000000001";
        const ids = Array.from(
          { length: 5 },
          (_, index) => `76000000-0000-4000-8000-00000000000${index + 2}`,
        );
        const turnIds = [ids[0]!, ids[0]!, ids[0]!, ids[3]!, ids[3]!];
        const entries = ids.map((uuid, index) => ({
          type: index === 0 || index === 3 ? "user" : "assistant",
          uuid,
          parentUuid: ids[index - 1] ?? null,
          sessionId,
          isSidechain: false,
          message:
            index === 0 || index === 3
              ? { role: "user", content: `prompt ${index}` }
              : { role: "assistant", content: [{ type: "text", text: `answer block ${index}` }] },
        }));
        const directory = claudeProjectDirectoryForTest(homePath, cwd);
        mkdirSync(directory, { recursive: true });
        const sourcePath = path.join(directory, `${sessionId}.jsonl`);
        const sourceBytes = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
        const forkMessageIds = Object.fromEntries(
          ids.map((nativeId, index) => [
            `selected-message-${index}`,
            { nativeId, turnId: turnIds[index], turnCount: index < 3 ? 1 : 2 },
          ]),
        );
        const harness = makeHarness({
          newQueryPerSession: true,
          environment: {},
          cwd,
          claudeConfig: { homePath },
          forkNativeSession: forkClaudeSdkSession,
        });
        return Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
          );
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: RESUME_THREAD_ID,
            cwd,
            runtimeMode: "full-access",
            resumeCursor: {
              threadId: RESUME_THREAD_ID,
              resume: sessionId,
              turnCount: 2,
              forkMessageIds,
            },
          });
          const targetThreadId = ThreadId.make(`selected-target-${selectedIndex}`);
          const cutoff = {
            sourceMessageId: MessageId.make(`selected-message-${selectedIndex}`),
            turnId: TurnId.make(turnIds[selectedIndex]!),
            retainedTurnCount: selectedIndex < 3 ? 1 : 2,
            includesCompleteTurn: selectedIndex === 2 || selectedIndex === 4,
          };
          const fork = yield* adapter.forkSession!({
            operationId: `selected-fork-${selectedIndex}`,
            sourceThreadId: RESUME_THREAD_ID,
            targetThreadId,
            title: "Selected branch",
            messageCutoff: cutoff,
            sourceMessageIds: ids
              .map((_, index) => MessageId.make(`selected-message-${index}`))
              .reverse(),
          });
          const cursor = fork.resumeCursor as {
            resume: string;
            turnCount: number;
            forkMessageIds: Record<string, { nativeId: string; turnId: string }>;
          };
          assert.equal(cursor.turnCount, cutoff.retainedTurnCount);
          assert.deepEqual(fork.messageCutoff, cutoff);
          assert.deepEqual(
            new Set(fork.retainedMessageIds),
            new Set(ids.slice(0, selectedIndex + 1).map((_, index) => `selected-message-${index}`)),
          );
          assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes);
          const copied = readFileSync(path.join(directory, `${cursor.resume}.jsonl`), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as SessionStoreEntry);
          assert.deepEqual(
            copied
              .filter((entry) => entry.type === "user" || entry.type === "assistant")
              .map((entry) => (entry.forkedFrom as { messageUuid: string }).messageUuid),
            ids.slice(0, selectedIndex + 1),
          );
          assert.equal(
            copied.some((entry) => entry.type === "cost-state"),
            false,
          );
          assert.equal(harness.query.closeCalls, 0);
          assert.equal(harness.query.interruptCalls.length, 0);
          assert.equal(harness.createInputs.length, 1);
          // A restarted target uses the durable remapping, including another fork
          // at the same original selected native block under copied Cafe IDs.
          yield* adapter.startSession({
            threadId: targetThreadId,
            cwd,
            runtimeMode: "full-access",
            resumeCursor: cursor,
          });
          const second = yield* adapter.forkSession!({
            operationId: `selected-fork-again-${selectedIndex}`,
            sourceThreadId: targetThreadId,
            targetThreadId: ThreadId.make(`selected-target-again-${selectedIndex}`),
            title: "Second branch",
            messageCutoff: {
              ...cutoff,
              sourceMessageId: MessageId.make(`copy:${targetThreadId}:${cutoff.sourceMessageId}`),
              turnId: TurnId.make(`copy:${targetThreadId}:${cutoff.turnId}`),
            },
            sourceMessageIds: fork.retainedMessageIds!.map((id) =>
              MessageId.make(`copy:${targetThreadId}:${id}`),
            ),
          });
          assert.notEqual((second.resumeCursor as { resume: string }).resume, cursor.resume);
          assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes);
          if (selectedIndex === 2) {
            const wholeThreadId = ThreadId.make("whole-then-selected");
            const whole = yield* adapter.forkSession!({
              operationId: "whole-before-selected",
              sourceThreadId: RESUME_THREAD_ID,
              targetThreadId: wholeThreadId,
              title: "Whole branch",
            });
            yield* adapter.startSession({
              threadId: wholeThreadId,
              cwd,
              runtimeMode: "full-access",
              resumeCursor: whole.resumeCursor,
            });
            const selectedAfterWhole = yield* adapter.forkSession!({
              operationId: "selected-after-whole",
              sourceThreadId: wholeThreadId,
              targetThreadId: ThreadId.make("selected-after-whole"),
              title: "Selected after whole fork",
              messageCutoff: {
                ...cutoff,
                sourceMessageId: MessageId.make(`copy:${wholeThreadId}:${cutoff.sourceMessageId}`),
                turnId: TurnId.make(`copy:${wholeThreadId}:${cutoff.turnId}`),
              },
              sourceMessageIds: ids.map((_, index) =>
                MessageId.make(`copy:${wholeThreadId}:selected-message-${index}`),
              ),
            });
            assert.equal(selectedAfterWhole.retainedMessageIds?.length, 3);
            assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes);
          }
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  it.effect(
    "refuses selected Claude forks for unmapped, wrong-turn, compacted, active and moving sources",
    () => {
      const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-selected-fork-refusal-"));
      const cwd = path.join(homePath, "workspace");
      const sessionId = "77000000-0000-4000-8000-000000000001";
      const nativeId = "77000000-0000-4000-8000-000000000002";
      const directory = claudeProjectDirectoryForTest(homePath, cwd);
      mkdirSync(directory, { recursive: true });
      const sourcePath = path.join(directory, `${sessionId}.jsonl`);
      const bytes =
        JSON.stringify({
          type: "user",
          uuid: nativeId,
          parentUuid: null,
          sessionId,
          isSidechain: false,
          message: { role: "user", content: "retained source" },
        }) + "\n";
      writeFileSync(sourcePath, bytes, { mode: 0o600 });
      let nativeCalls = 0;
      const harness = makeHarness({
        environment: {},
        cwd,
        claudeConfig: { homePath },
        forkNativeSession: async (id, options) => {
          nativeCalls += 1;
          // A background writer waking between admission and publication must
          // invalidate the snapshot, without interrupting its source query.
          writeFileSync(
            sourcePath,
            bytes + JSON.stringify({ type: "system", subtype: "notification" }) + "\n",
          );
          return forkClaudeSdkSession(id, options);
        },
      });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
        );
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          cwd,
          runtimeMode: "full-access",
          resumeCursor: {
            threadId: RESUME_THREAD_ID,
            resume: sessionId,
            turnCount: 1,
            forkMessageIds: {
              exact: { nativeId, turnId: nativeId, turnCount: 1 },
              compacted: {
                nativeId: "77000000-0000-4000-8000-000000000099",
                turnId: nativeId,
                turnCount: 1,
              },
            },
          },
        });
        for (const [messageId, turnId] of [
          ["unmapped", nativeId],
          ["exact", "wrong-turn"],
          ["compacted", nativeId],
          ["exact", nativeId],
        ]) {
          const result = yield* adapter.forkSession!({
            operationId: `refuse-${messageId}-${turnId}`,
            sourceThreadId: RESUME_THREAD_ID,
            targetThreadId: ThreadId.make("selected-refused"),
            title: "Refused",
            sourceMessageIds: [MessageId.make(messageId!)],
            messageCutoff: {
              sourceMessageId: MessageId.make(messageId!),
              turnId: TurnId.make(turnId!),
              retainedTurnCount: 1,
              includesCompleteTurn: false,
            },
          }).pipe(Effect.flip);
          assert.equal(result._tag, "ProviderAdapterValidationError");
        }
        assert.equal(nativeCalls, 1);
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(harness.query.interruptCalls.length, 0);
        const started = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.started"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "late-fork-child",
          tool_use_id: "late-fork-tool",
          task_type: "local_agent",
          description: "Still working",
          session_id: sessionId,
          uuid: "77000000-0000-4000-8000-000000000098",
        } as unknown as SDKMessage);
        yield* Fiber.join(started);
        const active = yield* adapter.forkSession!({
          operationId: "active-child-refusal",
          sourceThreadId: RESUME_THREAD_ID,
          targetThreadId: ThreadId.make("active-refused"),
          title: "Refused",
          sourceMessageIds: [MessageId.make("exact")],
          messageCutoff: {
            sourceMessageId: MessageId.make("exact"),
            turnId: TurnId.make(nativeId),
            retainedTurnCount: 1,
            includesCompleteTurn: false,
          },
        }).pipe(Effect.flip);
        assert.equal(active._tag, "ProviderAdapterValidationError");
        assert.equal(nativeCalls, 1);
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(harness.query.interruptCalls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "persists distinct native wrapper cutoffs for multiple assistant blocks in one Cafe turn",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          messageId: MessageId.make("mapped-user"),
          input: "hello",
        });
        const completedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const sessionId = "78000000-0000-4000-8000-000000000001";
        const nativeIds = [
          "78000000-0000-4000-8000-000000000002",
          "78000000-0000-4000-8000-000000000003",
        ];
        for (const [index, uuid] of nativeIds.entries())
          harness.query.emit({
            type: "assistant",
            session_id: sessionId,
            uuid,
            parent_tool_use_id: null,
            message: {
              id: "one-shared-native-api-message",
              content: [{ type: "text", text: `separate block ${index}` }],
            },
          } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: sessionId,
          uuid: "78000000-0000-4000-8000-000000000004",
        } as unknown as SDKMessage);
        const completed = yield* Fiber.join(completedFiber);
        assert.equal(completed._tag, "Some");
        if (completed._tag !== "Some" || completed.value.type !== "turn.completed") return;
        const cursor = (
          completed.value.payload as unknown as {
            resumeCursor: {
              forkMessageIds: Record<
                string,
                { nativeId: string; turnId: string; turnCount: number }
              >;
            };
          }
        ).resumeCursor;
        assert.deepEqual(cursor.forkMessageIds["mapped-user"], {
          nativeId: turn.turnId,
          turnId: turn.turnId,
          turnCount: 1,
        });
        const assistants = Object.entries(cursor.forkMessageIds).filter(([key]) =>
          key.startsWith("assistant:"),
        );
        assert.equal(assistants.length, 2);
        assert.deepEqual(
          assistants.map(([, value]) => value.nativeId),
          nativeIds,
        );
        assert.isTrue(assistants.every(([, value]) => value.turnId === turn.turnId));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("forks and deletes a same-workspace Claude transcript through the SDK store", () => {
    const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-native-fork-home-"));
    const cwd = path.join(homePath, "workspace");
    const sourceSessionId = "550e8400-e29b-41d4-a716-446655440010";
    const targetSessionId = "550e8400-e29b-41d4-a716-446655440011";
    const projectKey = claudeProjectDirectoryName(path, cwd);
    const projectDirectory = claudeProjectDirectoryForTest(homePath, cwd);
    const sourcePath = path.join(projectDirectory, `${sourceSessionId}.jsonl`);
    const targetPath = path.join(projectDirectory, `${targetSessionId}.jsonl`);
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(
      sourcePath,
      `${JSON.stringify({ type: "user", uuid: "550e8400-e29b-41d4-a716-446655440012" })}\n`,
      { mode: 0o600 },
    );

    let observedTitle: string | undefined;
    const harness = makeHarness({
      newQueryPerSession: true,
      environment: {},
      cwd,
      claudeConfig: { homePath },
      forkNativeSession: async (sessionId, options) => {
        assert.equal(sessionId, sourceSessionId);
        assert.equal(options.dir, cwd);
        observedTitle = options.title;
        const store = options.sessionStore;
        assert.isDefined(store);
        const entries = await store.load({ projectKey, sessionId: sourceSessionId });
        assert.isNotNull(entries);
        await store.append({ projectKey, sessionId: targetSessionId }, entries ?? []);
        return { sessionId: targetSessionId };
      },
      deleteNativeSession: async (sessionId, options) => {
        assert.equal(sessionId, targetSessionId);
        const store = options.sessionStore;
        assert.isDefined(store);
        await store.delete?.({ projectKey, sessionId });
      },
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        cwd,
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: sourceSessionId,
          turnCount: 3,
        },
        maxConcurrentSubagents: 7,
        runtimeMode: "full-access",
      });

      const fork = yield* adapter.forkSession!({
        operationId: "cmd-native-claude-fork",
        sourceThreadId: RESUME_THREAD_ID,
        targetThreadId: ThreadId.make("thread-claude-fork-target"),
        title: "Native Claude fork",
      });
      assert.equal(observedTitle, "Native Claude fork");
      assert.equal(fork.maxConcurrentSubagents, 7);
      const forkResumed = yield* adapter.startSession({
        threadId: fork.targetThreadId,
        cwd,
        runtimeMode: "full-access",
        resumeCursor: fork.resumeCursor,
        maxConcurrentSubagents: fork.maxConcurrentSubagents,
      });
      assert.equal(forkResumed.maxConcurrentSubagents, 7);
      assert.equal(harness.createInputs[1]?.options.resume, targetSessionId);
      assert.equal(harness.createInputs[1]?.options.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "7");
      assert.equal(harness.createInputs[0]?.options.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "7");
      const publication = (
        fork.resumeCursor as {
          forkPublication: { configurationDirectory: string; commitment: string };
        }
      ).forkPublication;
      assert.match(publication.commitment, /^[a-f0-9]{64}$/);
      assert.deepEqual(fork.resumeCursor, {
        threadId: ThreadId.make("thread-claude-fork-target"),
        resume: targetSessionId,
        turnCount: 3,
        forkPublication: publication,
      });
      assert.equal(existsSync(targetPath), true);
      if (process.platform !== "win32") {
        assert.equal(statSync(targetPath).mode & 0o777, 0o600);
      }

      assert.equal((yield* adapter.discardSessionFork!(fork).pipe(Effect.result))._tag, "Failure");
      assert.equal(existsSync(targetPath), true);
      yield* adapter.stopSession(fork.targetThreadId);
      yield* adapter.discardSessionFork!(fork);
      assert.equal(existsSync(targetPath), false);
      assert.equal(existsSync(sourcePath), true);
    }).pipe(Effect.provide(harness.layer));
  });

  for (const replacement of ["file", "namespace", "profile"] as const) {
    it.effect(
      `preserves a Claude fork when its compensation ${replacement} identity changes`,
      () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "claude-fork-compensation-"));
        const homePath = path.join(root, "original-profile");
        const cwd = path.join(root, "workspace");
        const sourceSessionId = "59000000-0000-4000-8000-000000000001";
        const targetSessionId = "59000000-0000-4000-8000-000000000002";
        const projectKey = claudeProjectDirectoryName(path, cwd);
        const directory = claudeProjectDirectoryForTest(homePath, cwd);
        const targetPath = path.join(directory, `${targetSessionId}.jsonl`);
        const sourcePath = path.join(directory, `${sourceSessionId}.jsonl`);
        const contents = `${JSON.stringify({ type: "user", uuid: "59000000-0000-4000-8000-000000000003" })}\n`;
        mkdirSync(directory, { recursive: true });
        writeFileSync(sourcePath, contents, { mode: 0o600 });
        const deleteNativeSession: NonNullable<
          ClaudeAdapterLiveOptions["deleteNativeSession"]
        > = async (sessionId, options) => {
          const store = options.sessionStore;
          assert.isDefined(store);
          await store.delete!({ projectKey, sessionId });
        };
        const harness = makeHarness({
          environment: {},
          cwd,
          claudeConfig: { homePath },
          deleteNativeSession,
          forkNativeSession: async (_sessionId, options) => {
            const store = options.sessionStore;
            assert.isDefined(store);
            await store.append(
              { projectKey, sessionId: targetSessionId },
              (await store.load({ projectKey, sessionId: sourceSessionId }))!,
            );
            return { sessionId: targetSessionId };
          },
        });
        return Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(root, { recursive: true, force: true })),
          );
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: RESUME_THREAD_ID,
            cwd,
            runtimeMode: "full-access",
            resumeCursor: { resume: sourceSessionId, turnCount: 1 },
          });
          const fork = yield* adapter.forkSession!({
            operationId: `cleanup-${replacement}`,
            sourceThreadId: RESUME_THREAD_ID,
            targetThreadId: ThreadId.make("cleanup-target"),
            title: "Cleanup fixture",
          });
          let preservedPath = targetPath;
          if (replacement === "namespace") {
            renameSync(directory, `${directory}-original`);
            mkdirSync(directory);
            writeFileSync(targetPath, contents, { mode: 0o600 });
          } else if (replacement === "file") {
            renameSync(targetPath, `${targetPath}.original`);
            writeFileSync(targetPath, contents, { mode: 0o600 });
          }
          const result =
            replacement === "profile"
              ? yield* Effect.gen(function* () {
                  const otherHome = path.join(root, "replacement-profile");
                  const otherDirectory = claudeProjectDirectoryForTest(otherHome, cwd);
                  mkdirSync(otherDirectory, { recursive: true });
                  preservedPath = path.join(otherDirectory, `${targetSessionId}.jsonl`);
                  writeFileSync(preservedPath, contents, { mode: 0o600 });
                  const replacementHarness = makeHarness({
                    environment: {},
                    cwd,
                    claudeConfig: { homePath: otherHome },
                    deleteNativeSession,
                  });
                  return yield* Effect.gen(function* () {
                    return yield* (yield* ClaudeAdapter).discardSessionFork!(fork).pipe(
                      Effect.result,
                    );
                  }).pipe(Effect.provide(replacementHarness.layer));
                })
              : yield* adapter.discardSessionFork!(fork).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.equal(readFileSync(preservedPath, "utf8"), contents);
          assert.equal(
            readFileSync(
              replacement === "namespace"
                ? path.join(`${directory}-original`, `${sourceSessionId}.jsonl`)
                : sourcePath,
              "utf8",
            ),
            contents,
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  it.effect("refuses to overwrite a symlinked Claude fork transcript", () => {
    const homePath = mkdtempSync(path.join(os.tmpdir(), "claude-native-fork-symlink-home-"));
    const cwd = path.join(homePath, "workspace");
    const sourceSessionId = "550e8400-e29b-41d4-a716-446655440020";
    const targetSessionId = "550e8400-e29b-41d4-a716-446655440021";
    const projectKey = claudeProjectDirectoryName(path, cwd);
    const projectDirectory = claudeProjectDirectoryForTest(homePath, cwd);
    const sourcePath = path.join(projectDirectory, `${sourceSessionId}.jsonl`);
    const targetPath = path.join(projectDirectory, `${targetSessionId}.jsonl`);
    const victimPath = path.join(homePath, "victim.txt");
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(sourcePath, `${JSON.stringify({ type: "user" })}\n`, { mode: 0o600 });
    writeFileSync(victimPath, "do not overwrite");
    try {
      symlinkSync(victimPath, targetPath);
    } catch (cause) {
      if (
        process.platform === "win32" &&
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "EPERM"
      ) {
        rmSync(homePath, { recursive: true, force: true });
        return Effect.void;
      }
      throw cause;
    }

    const harness = makeHarness({
      cwd,
      claudeConfig: { homePath },
      forkNativeSession: async (sessionId, options) => {
        const store = options.sessionStore;
        assert.isDefined(store);
        const entries = await store.load({ projectKey, sessionId });
        await store.append({ projectKey, sessionId: targetSessionId }, entries ?? []);
        return { sessionId: targetSessionId };
      },
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
      );
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        cwd,
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: sourceSessionId,
          turnCount: 1,
        },
        runtimeMode: "full-access",
      });

      const result = yield* adapter.forkSession!({
        operationId: "cmd-symlink-claude-fork",
        sourceThreadId: RESUME_THREAD_ID,
        targetThreadId: ThreadId.make("thread-claude-symlink-fork-target"),
        title: "Unsafe target",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(readFileSync(victimPath, "utf8"), "do not overwrite");
      assert.equal(existsSync(sourcePath), true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits Claude process stderr diagnostics as runtime warnings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const warningFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.raw?.method === "process/stderr",
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const stderr = harness.getLastCreateQueryInput()?.options.stderr;
      assert.equal(typeof stderr, "function");
      if (typeof stderr !== "function") {
        return;
      }
      stderr("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use\n");
      yield* Effect.yieldNow;
      stderr("\u001B[31mWARN slow stream path\u001B[0m\n");

      const warning = yield* Fiber.join(warningFiber);
      assert.equal(warning._tag, "Some");
      if (warning._tag !== "Some" || warning.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(warning.value.payload.message, "Claude process stderr.");
      assert.equal(warning.value.raw?.source, "claude.sdk.message");
      assert.equal(warning.value.raw?.method, "process/stderr");
      const detail = warning.value.payload.detail as { readonly line?: string } | undefined;
      assert.equal(detail?.line, "WARN slow stream path");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude turn-start diagnostics when the SDK stream stays silent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const warningFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "runtime.warning" &&
          event.raw?.method === "claude.turnStart/noSdkMessageYet",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;

      const warning = yield* Fiber.join(warningFiber);
      assert.equal(warning._tag, "Some");
      if (warning._tag !== "Some" || warning.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(warning.value.raw?.source, "claude.sdk.message");
      assert.equal(warning.value.raw?.method, "claude.turnStart/noSdkMessageYet");
      const detail = warning.value.payload.detail as
        | {
            readonly sdkMessageCount?: number;
            readonly promptTextBytes?: number;
            readonly promptAttachmentCount?: number;
          }
        | undefined;
      assert.equal(detail?.sdkMessageCount, 0);
      assert.equal(detail?.promptTextBytes, 5);
      assert.equal(detail?.promptAttachmentCount, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/tmp/claude-adapter-test",
        tools: [],
        mcp_servers: [],
        model: "claude-sonnet-4-5",
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        session_id: durableSessionId,
        uuid: "resume-init",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not replace a durable Claude resume id with a zero-turn failed session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const failedSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["No message found with message.uuid of: assistant-99"],
        session_id: failedSessionId,
        uuid: "failed-result",
        num_turns: 0,
      } as unknown as SDKMessage);

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag !== "Some" || completed.value.type !== "turn.completed") {
        return;
      }
      const payload = completed.value.payload as {
        readonly resumeCursor?: {
          readonly resume?: string;
          readonly turnCount?: number;
        };
      };
      assert.equal(payload.resumeCursor?.resume, durableSessionId);
      assert.equal(payload.resumeCursor?.turnCount, 3);

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
            readonly turnCount?: number;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
      assert.equal(resumeCursor?.turnCount, 3);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("lets Claude allocate fresh session ids without persisting a zero-turn cursor", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(session.resumeCursor, undefined);
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resume, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores stale zero-turn Claude resume cursors on startup", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: "550e8400-e29b-41d4-a716-446655440000",
          turnCount: 0,
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(session.resumeCursor, undefined);
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits a durable Claude resume cursor after the first completed turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      assert.equal(harness.getLastCreateQueryInput()?.options.sessionId, undefined);
      const sessionId = "550e8400-e29b-41d4-a716-446655440001";

      harness.query.emit({
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-first-turn",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-first-turn",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: sessionId,
        uuid: "result-first-turn",
      } as unknown as SDKMessage);

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag !== "Some" || completed.value.type !== "turn.completed") {
        return;
      }
      const payload = completed.value.payload as {
        readonly resumeCursor?: {
          readonly threadId?: string;
          readonly resume?: string;
          readonly resumeSessionAt?: string;
          readonly turnCount?: number;
        };
      };
      assert.equal(payload.resumeCursor?.threadId, THREAD_ID);
      assert.equal(payload.resumeCursor?.resume, sessionId);
      assert.equal(payload.resumeCursor?.resumeSessionAt, undefined);
      assert.equal(payload.resumeCursor?.turnCount, 1);

      const activeSessions = yield* adapter.listSessions();
      assert.deepEqual(activeSessions[0]?.resumeCursor, payload.resumeCursor);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "refuses local-only rollback instead of claiming native conversation history changed",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-first",
        } as unknown as SDKMessage);

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");
        if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-second",
        } as unknown as SDKMessage);

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");
        if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1).pipe(Effect.exit);
        assert.equal(rolledBack._tag, "Failure");

        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 2);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({ instanceId: customInstanceId });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "claude-session-same-model",
          uuid: "result-same-model-first-turn",
          user_message_uuid: firstTurn.turnId,
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "claude-session-model-change",
        uuid: "result-model-change-first-turn",
        user_message_uuid: firstTurn.turnId,
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]", "claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts the Claude query in plan mode for a first plan turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "plan");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "switches an established Claude session between Auto and Manual through the SDK",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "inspect this",
          interactionMode: "default",
          attachments: [],
        });
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-auto-transition",
          uuid: "result-auto-transition",
          user_message_uuid: firstTurn.turnId,
        } as unknown as SDKMessage);
        yield* Fiber.join(turnCompletedFiber);

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "continue in auto mode",
          interactionMode: "auto",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["auto"]);
        const autoCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-auto-transition",
          uuid: "result-manual-transition",
          user_message_uuid: secondTurn.turnId,
        } as unknown as SDKMessage);
        yield* Fiber.join(autoCompletedFiber);
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "continue with manual approvals",
          interactionMode: "default",
          attachments: [],
        });
        assert.deepEqual(harness.query.setPermissionModeCalls, ["auto", "default"]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
  ])(
    "restores $expectedBase permission mode after plan turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
          interactionMode: "plan",
        });

        // First turn in plan mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-${runtimeMode}`,
          uuid: `result-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, [expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("skips redundant default permission mode control request on first sendTurn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        interactionMode: "default",
        attachments: [],
      });

      assert.equal(harness.getLastCreateQueryInput()?.options.permissionMode, "bypassPermissions");
      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        interactionMode: "plan",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-1",
          requestId: "permission-request-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        interactionMode: "plan",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
        requestId: "permission-request-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-2",
        requestId: "permission-request-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Deploy to which env?": "Staging",
      });

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-abort",
          requestId: "permission-request-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects pre-aborted Claude questions and approvals without waiting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const canUseTool = harness.getLastCreateQueryInput()!.options.canUseTool!;
      const controller = new AbortController();
      controller.abort();
      for (const tool of ["AskUserQuestion", "Bash"]) {
        const result = yield* Effect.promise(() =>
          canUseTool(
            tool,
            {},
            { signal: controller.signal, toolUseID: "aborted", requestId: "aborted" },
          ),
        );
        assert.equal(result?.behavior, "deny");
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("validates MCP form answers before consuming the Claude callback", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const callback = harness.getLastCreateQueryInput()!.options.onElicitation!;
      const result = callback(
        {
          serverName: "mcp",
          message: "Choose",
          requestedSchema: {
            type: "object",
            properties: { enabled: { type: "boolean" }, count: { type: "integer", minimum: 1 } },
            required: ["enabled", "count"],
          },
        },
        { signal: new AbortController().signal, requestId: "native-form" },
      );
      const opened = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some" || opened.value.type !== "user-input.requested") return;
      assert.equal(opened.value.payload.interaction?.kind, "elicitation");
      assert.isUndefined(opened.value.raw);
      const id = ApprovalRequestId.make(String(opened.value.requestId));
      const invalid = yield* adapter
        .respondToUserInput(THREAD_ID, id, {
          __cafeInteraction: { action: "accept", content: { enabled: "true", count: 2 } },
        })
        .pipe(Effect.exit);
      assert.equal(invalid._tag, "Failure");
      yield* adapter.respondToUserInput(THREAD_ID, id, {
        __cafeInteraction: { action: "accept", content: { enabled: true, count: 2 } },
      });
      assert.deepEqual(yield* Effect.promise(() => result), {
        action: "accept",
        content: { enabled: true, count: 2 },
      });
      const closed = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(closed._tag, "Some");
      if (closed._tag === "Some" && closed.value.type === "user-input.resolved")
        assert.deepEqual(closed.value.payload.answers, { __cafeInteraction: { action: "accept" } });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps MCP authorization URLs transient and revokes them on cancellation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const callback = harness.getLastCreateQueryInput()!.options.onElicitation!;
      const controller = new AbortController();
      const url = "https://auth.example.test/authorize?token=private-token";
      const result = callback(
        { serverName: "mcp", message: "Authenticate", mode: "url", url },
        { signal: controller.signal, requestId: "native-url" },
      );
      const opened = yield* Stream.runHead(adapter.streamEvents);
      if (opened._tag !== "Some" || opened.value.type !== "user-input.requested")
        return assert.fail("Expected elicitation request");
      assert.notInclude(JSON.stringify(opened.value), "private-token");
      const id = ApprovalRequestId.make(String(opened.value.requestId));
      assert.equal(yield* adapter.resolveInteractionUrl!(THREAD_ID, id), url);
      controller.abort();
      assert.deepEqual(yield* Effect.promise(() => result), { action: "cancel" });
      assert.equal(
        (yield* adapter.resolveInteractionUrl!(THREAD_ID, id).pipe(Effect.exit))._tag,
        "Failure",
      );
      assert.deepEqual(
        yield* Effect.promise(() =>
          callback(
            { serverName: "mcp", message: "Bad", mode: "url", url: "javascript:alert(1)" },
            { signal: new AbortController().signal, requestId: "bad-url" },
          ),
        ),
        { action: "decline" },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "opens a fresh bounded MCP authorization callback after a prior authorization completes",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const callback = harness.getLastCreateQueryInput()!.options.onElicitation!;
        let previousRequestId: string | undefined;
        for (const scope of ["read", "read-write"]) {
          const url = `https://auth.example.test/authorize?scope=${scope}&token=private`;
          const pending = callback(
            { serverName: "mcp", message: "Authorize requested scopes", mode: "url", url },
            { signal: new AbortController().signal, requestId: `native-${scope}` },
          );
          const opened = yield* Stream.runHead(adapter.streamEvents);
          if (opened._tag !== "Some" || opened.value.type !== "user-input.requested")
            return assert.fail("Expected authorization callback");
          const id = ApprovalRequestId.make(String(opened.value.requestId));
          assert.notEqual(id, previousRequestId);
          assert.notInclude(JSON.stringify(opened.value), "private");
          assert.equal(yield* adapter.resolveInteractionUrl!(THREAD_ID, id), url);
          yield* adapter.respondToUserInput(THREAD_ID, id, {
            __cafeInteraction: { action: "accept" },
          });
          assert.deepEqual(yield* Effect.promise(() => pending), { action: "accept" });
          yield* Stream.runHead(adapter.streamEvents);
          assert.equal(
            (yield* adapter.resolveInteractionUrl!(THREAD_ID, id).pipe(Effect.exit))._tag,
            "Failure",
          );
          previousRequestId = id;
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "settles a truncated Claude stream from the authoritative result without message_stop",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "approval-required" });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        const assistant: SDKAssistantMessage = {
          type: "assistant",
          session_id: "sdk-truncated",
          uuid: "71000000-0000-4000-8000-000000000020",
          parent_tool_use_id: null,
          message: {
            id: "api-truncated",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-6",
            container: null,
            context_management: null,
            diagnostics: null,
            stop_details: null,
            stop_reason: null,
            stop_sequence: null,
            usage: makeSuccessfulClaudeResult("sdk-truncated").usage,
            content: [{ type: "text", text: "Hello world", citations: null }],
          },
          aborted: true,
        };
        const partialEvents: Array<Extract<SDKMessage, { type: "stream_event" }>["event"]> = [
          { type: "message_start", message: { ...assistant.message, content: [] } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
          },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        ];
        for (const event of partialEvents)
          harness.query.emit({
            type: "stream_event",
            session_id: "sdk-truncated",
            uuid: "71000000-0000-4000-8000-000000000021",
            parent_tool_use_id: null,
            event,
          });
        harness.query.emit(assistant);
        harness.query.emit(makeSuccessfulClaudeResult("sdk-truncated"));
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
          "Hello world",
        );
        assert.equal(
          events.filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          ).length,
          1,
        );
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(completed?.payload.state, "completed");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some((record) =>
          /^sha256:[a-f0-9]{64}$/.test(
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ),
          ),
        ),
        true,
      );
      assert.notInclude(JSON.stringify(nativeEvents), "sdk-session-native-log");
      assert.notInclude(JSON.stringify(nativeEvents), "stream-native-log");
      assert.notInclude(JSON.stringify(nativeEvents), "result-native-log");
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
