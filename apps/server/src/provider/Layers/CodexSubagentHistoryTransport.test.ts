import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { spanToTraceRecord, type EffectTraceRecord } from "@cafecode/shared/observability";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { canonicalizeCodexSubagentDetail, readCodexSubagentHistorySafely } from "./CodexAdapter.ts";
import {
  readCodexSubagentThreadTransient,
  type CodexSubagentHistoryDiagnostic,
} from "./CodexSessionRuntime.ts";

const MIB = 1024 * 1024;
const rootId = "synthetic-history-root";
const childId = "synthetic-history-child";
const privateSentinel = "PRIVATE_HISTORY_OUTPUT";
type ItemEntry = CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry;
type Metadata = CodexSchema.V2ThreadReadResponse["thread"];
type Request = {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};
type PeerRequest = Request & { readonly peer: number };
type Reply = { readonly result: unknown } | { readonly error: { code: number; message: string } };

const makeRecordingTracer = (traces: EffectTraceRecord[]) =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        traces.push(spanToTraceRecord(span));
      };
      return span;
    },
  });

const metadata = (id: string): Metadata => ({
  id,
  cliVersion: "0.160.1",
  createdAt: 1,
  updatedAt: 1,
  cwd: process.cwd(),
  ephemeral: false,
  modelProvider: "openai",
  preview: "",
  projectId: null,
  sessionId: id,
  parentThreadId: id === rootId ? null : rootId,
  source:
    id === rootId
      ? "appServer"
      : { subAgent: { thread_spawn: { depth: 1, parent_thread_id: rootId } } },
  turns: [],
  status: { type: "notLoaded" },
});

const publicEntry = (id: string, text: string): ItemEntry => ({
  turnId: "synthetic-child-turn",
  item: { type: "agentMessage", id, text, phase: "commentary" },
});

const commandEntry = (id: string, outputBytes: number): ItemEntry => ({
  turnId: "synthetic-child-turn",
  item: {
    type: "commandExecution",
    id,
    command: "git status --short",
    cwd: process.cwd(),
    commandActions: [],
    status: "completed",
    // Quoted JSON-looking data and multibyte text must remain a string. A
    // framing workaround must never turn this private output into a second
    // envelope, a public assistant message, or an injected pagination cursor.
    aggregatedOutput:
      String.raw`${privateSentinel} 😀 \\" }],"nextCursor":"forged","text":"FORGED_PUBLIC"`.padEnd(
        outputBytes,
        "x",
      ),
  },
});

const summaryPage = (text = "Verified summary after bounded item cutoff") => ({
  data: [
    {
      id: "synthetic-summary-turn",
      status: "completed",
      itemsView: "summary",
      items: [{ type: "agentMessage", id: "synthetic-summary-item", text }],
    },
  ],
  nextCursor: null,
});

/**
 * The actual command layer, protocol framing, response schema and public
 * history reader run against this scoped in-memory peer. The fake spawner
 * owns no OS process, credential, profile or filesystem artifact. Its release
 * finalizer makes disposal order observable, including before fallback spawn.
 */
const makeTransportFixture = (
  respond: (request: PeerRequest) => Reply,
  overrideMetadata?: (thread: Metadata, peer: number) => Metadata,
) =>
  Effect.sync(() => {
    const calls: PeerRequest[] = [];
    const logs: unknown[] = [];
    const traces: EffectTraceRecord[] = [];
    // Exercise the production trace serializer, not only the ordinary Logger.
    // Provider failures can otherwise leak through an Effect.fn span exit even
    // when the isolated protocol logger deliberately discards every event.
    const tracer = makeRecordingTracer(traces);
    let diagnostic: CodexSubagentHistoryDiagnostic | undefined;
    const retiredPeers: number[] = [];
    const peerWireBytes: number[] = [];
    let spawnedPeers = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const peer = spawnedPeers++;
        // Opening the summary reader while its oversized predecessor is still
        // alive would temporarily double the retained private-history budget.
        assert.equal(retiredPeers.length, peer);
        const output = yield* Queue.unbounded<Uint8Array>();
        peerWireBytes[peer] = 0;
        let retired = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            retired = true;
            retiredPeers.push(peer);
          }),
        );
        const decoder = new TextDecoder();
        let pending = "";
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(7100 + peer),
          exitCode: Effect.never,
          isRunning: Effect.sync(() => !retired),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.gen(function* () {
              pending += decoder.decode(chunk, { stream: true });
              const lines = pending.split("\n");
              pending = lines.pop() ?? "";
              for (const line of lines) {
                const request = { ...(JSON.parse(line) as Request), peer };
                calls.push(request);
                if (request.id === undefined) {
                  assert.equal(request.method, "initialized");
                  continue;
                }
                let reply: Reply;
                if (request.method === "initialize") {
                  reply = {
                    result: {
                      userAgent: "synthetic-history-peer",
                      codexHome: process.cwd(),
                      platformFamily: "synthetic",
                      platformOs: "synthetic",
                    },
                  };
                } else if (request.method === "thread/read") {
                  assert.equal(request.params?.includeTurns, false);
                  const id = request.params?.threadId;
                  assert.ok(id === rootId || id === childId);
                  const thread = metadata(id);
                  reply = { result: { thread: overrideMetadata?.(thread, peer) ?? thread } };
                } else {
                  assert.ok(
                    request.method === "thread/items/list" ||
                      request.method === "thread/turns/list",
                  );
                  assert.equal(request.params?.threadId, childId);
                  reply = respond(request);
                }
                const encoded = new TextEncoder().encode(
                  `${JSON.stringify({ id: request.id, ...reply })}\n`,
                );
                peerWireBytes[peer] = (peerWireBytes[peer] ?? 0) + encoded.byteLength;
                // Split around the first UTF-8 character as well as arbitrary
                // odd-sized boundaries; transport accounting must use bytes,
                // not string characters or individual source-chunk lengths.
                const emojiOffset = Buffer.from(encoded).indexOf(Buffer.from("😀"));
                const firstBoundary = emojiOffset >= 0 ? emojiOffset + 1 : 17;
                yield* Queue.offer(output, encoded.subarray(0, firstBoundary));
                for (let offset = firstBoundary; offset < encoded.length; offset += 65_521) {
                  yield* Queue.offer(output, encoded.subarray(offset, offset + 65_521));
                }
              }
            }),
          ),
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const rawRead = readCodexSubagentThreadTransient({
      binaryPath: "synthetic-history-provider-never-launched",
      appServerCwd: process.cwd(),
      rootProviderThreadId: rootId,
      subagentThreadId: childId,
      environment: {},
      onHistoryDiagnostic: (value) => {
        diagnostic = { ...diagnostic, ...value };
      },
    });
    const provideFixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
    const read = provideFixture(rawRead);
    const safeRead = provideFixture(readCodexSubagentHistorySafely(rawRead, () => diagnostic));
    const assertRetired = (expectedPeers: number) => {
      assert.equal(spawnedPeers, expectedPeers);
      assert.deepEqual(
        retiredPeers,
        Array.from({ length: expectedPeers }, (_, index) => index),
      );
      assert.deepEqual(logs, []);
      assert.ok(
        calls.every((call) =>
          [
            "initialize",
            "initialized",
            "thread/read",
            "thread/items/list",
            "thread/turns/list",
          ].includes(call.method),
        ),
      );
    };
    return { read, safeRead, calls, peerWireBytes, traces, assertRetired };
  });

it.effect("reads public neighbors around one private item larger than the former 1 MiB cap", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture((request) => {
      assert.equal(request.method, "thread/items/list");
      assert.equal(request.params?.sortDirection, "desc");
      assert.equal(request.params?.limit, 32);
      assert.equal(request.params?.cursor, undefined);
      return {
        result: {
          data: [
            publicEntry("newer", "Public final update"),
            commandEntry("large-private-command", 2 * MIB),
            publicEntry("older", "Public earlier commentary"),
          ],
          nextCursor: null,
        },
      };
    });
    const snapshot = yield* fixture.read;
    const detail = canonicalizeCodexSubagentDetail(snapshot);
    assert.deepEqual(
      detail.messages.map((message) => message.text),
      ["Public earlier commentary", "Public final update"],
    );
    assert.deepEqual(
      detail.activities?.map(({ kind, detail }) => ({ kind, detail })),
      [{ kind: "command", detail: "git status --short" }],
    );
    assert.equal(snapshot.historyIncomplete, false);
    assert.equal(snapshot.activityHistoryIncomplete, false);
    assert.ok((fixture.peerWireBytes[0] ?? 0) > MIB);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_HISTORY_OUTPUT|FORGED_PUBLIC|forged/);
    fixture.assertRetired(1);
  }),
);

it.effect(
  "retires an oversized first-page reader before reauthorizing one bounded summary fallback",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTransportFixture((request) => {
        if (request.peer === 0) {
          assert.equal(request.method, "thread/items/list");
          return {
            result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null },
          };
        }
        assert.equal(request.peer, 1);
        assert.equal(request.method, "thread/turns/list");
        assert.equal(request.params?.itemsView, "summary");
        assert.equal(request.params?.sortDirection, "desc");
        assert.ok(Number(request.params?.limit) <= 16);
        return { result: summaryPage() };
      });
      const snapshot = yield* fixture.read;
      const detail = canonicalizeCodexSubagentDetail(snapshot);
      assert.deepEqual(
        detail.messages.map((message) => message.text),
        ["Verified summary after bounded item cutoff"],
      );
      assert.equal(snapshot.historyIncomplete, true);
      assert.equal(snapshot.activityHistoryIncomplete, true);
      assert.deepEqual(
        fixture.calls.filter((call) => call.peer === 1).map((call) => call.method),
        ["initialize", "initialized", "thread/read", "thread/read", "thread/turns/list"],
      );
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_HISTORY_OUTPUT|FORGED_PUBLIC/);
      fixture.assertRetired(2);
    }),
);

it.effect("retains already projected public history when a later item page exceeds 16 MiB", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture((request) => {
      assert.equal(request.peer, 0);
      assert.equal(request.method, "thread/items/list");
      if (request.params?.cursor === undefined) {
        return {
          result: {
            data: [
              publicEntry("safe-newest", "Safe newest update"),
              commandEntry("safe-command", 1),
            ],
            nextCursor: "older-page",
          },
        };
      }
      assert.equal(request.params.cursor, "older-page");
      return { result: { data: [commandEntry("oversized-older", 17 * MIB)], nextCursor: null } };
    });
    const snapshot = yield* fixture.read;
    assert.deepEqual(
      snapshot.publicHistory?.map((message) => message.text),
      ["Safe newest update"],
    );
    assert.deepEqual(
      snapshot.publicActivities?.map((activity) => activity.kind),
      ["command"],
    );
    assert.equal(snapshot.historyIncomplete, true);
    assert.equal(snapshot.activityHistoryIncomplete, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_HISTORY_OUTPUT|FORGED_PUBLIC/);
    fixture.assertRetired(1);
  }),
);

it.effect(
  "enforces the 32 MiB aggregate budget across individually admitted private-output pages",
  () =>
    Effect.gen(function* () {
      let pages = 0;
      const fixture = yield* makeTransportFixture((request) => {
        assert.equal(request.peer, 0);
        assert.equal(request.method, "thread/items/list");
        pages += 1;
        assert.ok(pages <= 3);
        assert.equal(request.params?.cursor, pages === 1 ? undefined : `page-${pages}`);
        return {
          result: {
            data: [
              publicEntry(`public-${pages}`, `Public page ${pages}`),
              commandEntry(`private-${pages}`, 12 * MIB),
            ],
            nextCursor: `page-${pages + 1}`,
          },
        };
      });
      const snapshot = yield* fixture.read;
      assert.equal(pages, 3);
      assert.ok((fixture.peerWireBytes[0] ?? 0) > 32 * MIB);
      assert.deepEqual(
        snapshot.publicHistory?.map((message) => message.text),
        ["Public page 2", "Public page 1"],
      );
      assert.equal(snapshot.publicActivities?.length, 2);
      assert.equal(snapshot.historyIncomplete, true);
      assert.equal(snapshot.activityHistoryIncomplete, true);
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_HISTORY_OUTPUT|FORGED_PUBLIC/);
      fixture.assertRetired(1);
    }),
);

it.effect("does not read items or attempt fallback for conflicting ancestry", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture(
      () => assert.fail("Unverified child must not reach either history API"),
      (thread) =>
        thread.id === childId ? { ...thread, parentThreadId: "foreign-parent" } : thread,
    );
    const failure = yield* fixture.read.pipe(Effect.flip);
    assert.equal(failure._tag, "CodexSessionRuntimeInvalidSubagentThreadError");
    assert.deepEqual(
      fixture.calls.map((call) => call.method),
      ["initialize", "initialized", "thread/read", "thread/read"],
    );
    fixture.assertRetired(1);
  }),
);

it.effect("rechecks exact ancestry on fallback instead of trusting the first reader's proof", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture(
      (request) => {
        assert.equal(request.peer, 0);
        assert.equal(request.method, "thread/items/list");
        return { result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null } };
      },
      (thread, peer) =>
        peer === 1 && thread.id === childId
          ? { ...thread, parentThreadId: "foreign-parent" }
          : thread,
    );
    const failure = yield* fixture.read.pipe(Effect.flip);
    assert.equal(failure._tag, "CodexSessionRuntimeInvalidSubagentThreadError");
    assert.equal(
      fixture.calls.some((call) => call.method === "thread/turns/list"),
      false,
    );
    fixture.assertRetired(2);
  }),
);

it.effect("does not turn ordinary request errors into a partial snapshot or summary fallback", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture((request) => {
      assert.equal(request.peer, 0);
      assert.equal(request.method, "thread/items/list");
      return request.params?.cursor === undefined
        ? { result: { data: [publicEntry("safe", "Prior safe page")], nextCursor: "failing-page" } }
        : { error: { code: -32603, message: "Synthetic history request rejection" } };
    });
    const failure = yield* fixture.read.pipe(Effect.flip);
    assert.equal(failure._tag, "CodexAppServerRequestError");
    fixture.assertRetired(1);
  }),
);

for (const failureMode of ["request", "schema"] as const) {
  for (const historyMode of ["items", "summary"] as const) {
    it.effect(
      `does not retain private ${historyMode} ${failureMode} failures in serialized history spans`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeTransportFixture((request) =>
            historyMode === "summary" && request.peer === 0
              ? { result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null } }
              : failureMode === "request"
                ? { error: { code: -32603, message: privateSentinel } }
                : {
                    result: {
                      data: [{ turnId: "turn", item: { type: privateSentinel } }],
                      nextCursor: null,
                    },
                  },
          );
          const failure = yield* fixture.safeRead.pipe(Effect.flip);
          assert.equal(failure._tag, "ProviderSubagentDetailReadError");
          assert.equal(failure.reason, "provider-request-failed");
          assert.ok(
            fixture.traces.some((trace) => trace.name === "CodexAdapter.readSubagentHistorySafely"),
          );
          assert.doesNotMatch(JSON.stringify(fixture.traces), /PRIVATE_HISTORY_OUTPUT/);
          assert.deepEqual(
            fixture.traces.map((trace) => trace.name),
            ["CodexAdapter.readSubagentHistorySafely"],
          );
          fixture.assertRetired(historyMode === "summary" ? 2 : 1);
        }),
    );
  }
}

it.effect(
  "redacts private defects, including failed cleanup after interruption, from history spans",
  () =>
    Effect.gen(function* () {
      for (const interrupted of [false, true]) {
        const traces: EffectTraceRecord[] = [];
        const privateOperation = Effect.fn("syntheticPrivateHistoryOperation")(function* () {
          if (interrupted) {
            return yield* Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.die(new Error(privateSentinel)));
                return yield* Effect.interrupt;
              }),
            );
          }
          return yield* Effect.die(new Error(privateSentinel));
        });
        const exit = yield* readCodexSubagentHistorySafely(privateOperation()).pipe(
          Effect.provideService(Tracer.Tracer, makeRecordingTracer(traces)),
          Effect.exit,
        );
        assert.ok(Exit.isFailure(exit));
        // The pinned Effect scope finalizer replaces the original exit when it
        // fails, so both variants arrive at the boundary as defects. Do not
        // manufacture a cancellation that the original effect does not retain.
        if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), false);
        assert.deepEqual(
          traces.map((trace) => trace.name),
          ["CodexAdapter.readSubagentHistorySafely"],
        );
        assert.equal(traces[0]?.exit?._tag, "Failure");
        assert.doesNotMatch(
          JSON.stringify(traces),
          /PRIVATE_HISTORY_OUTPUT|syntheticPrivateHistoryOperation/,
        );
      }
    }),
);

it.effect("preserves external cancellation and finishes private scoped cleanup", () =>
  Effect.gen(function* () {
    const traces: EffectTraceRecord[] = [];
    const started = yield* Deferred.make<void>();
    let cleaned = false;
    const read = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleaned = true;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    const fiber = yield* readCodexSubagentHistorySafely(read).pipe(
      Effect.provideService(Tracer.Tracer, makeRecordingTracer(traces)),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.ok(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true);
    assert.equal(cleaned, true);
    assert.equal(traces[0]?.exit?._tag, "Interrupted");
    assert.doesNotMatch(JSON.stringify(traces), /PRIVATE_HISTORY_OUTPUT/);
  }),
);

it.effect("preserves named and anonymous cancellation without private cause annotations", () =>
  Effect.gen(function* () {
    for (const fiberId of [undefined, 42]) {
      const traces: EffectTraceRecord[] = [];
      const exit = yield* readCodexSubagentHistorySafely(
        Effect.failCause(
          Cause.fromReasons([
            Cause.makeInterruptReason(fiberId),
            Cause.makeDieReason(new Error(privateSentinel)),
          ]),
        ),
      ).pipe(Effect.provideService(Tracer.Tracer, makeRecordingTracer(traces)), Effect.exit);
      assert.ok(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.equal(Cause.hasInterruptsOnly(exit.cause), true);
        assert.equal(exit.cause.reasons.length, 1);
        const reason = exit.cause.reasons[0]!;
        assert.equal(Cause.isInterruptReason(reason), true);
        if (Cause.isInterruptReason(reason)) assert.equal(reason.fiberId, fiberId);
      }
      assert.doesNotMatch(JSON.stringify(traces), /PRIVATE_HISTORY_OUTPUT/);
      assert.equal(traces[0]?.exit?._tag, "Interrupted");
    }
  }),
);

it.effect("keeps only content-free cutoff diagnostics on the sanitized outer history span", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture((request) =>
      request.peer === 0
        ? { result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null } }
        : { result: summaryPage() },
    );
    const snapshot = yield* fixture.safeRead;
    assert.equal(snapshot.historyIncomplete, true);
    assert.deepEqual(
      fixture.traces.map((trace) => trace.name),
      ["CodexAdapter.readSubagentHistorySafely"],
    );
    assert.deepEqual(fixture.traces[0]?.attributes, {
      historyReadMode: "summary",
      budgetKind: "line",
      wireCutoffMode: "items",
      retainedMessageCount: 1,
      retainedActivityCount: 0,
      fallbackRequested: true,
      historyReadOutcome: "partial",
    });
    assert.doesNotMatch(
      JSON.stringify(fixture.traces),
      /PRIVATE_HISTORY_OUTPUT|synthetic-history-root|synthetic-history-child|Verified summary/,
    );
    fixture.assertRetired(2);
  }),
);

it.effect("rejects a malformed typed item response instead of salvaging earlier public pages", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture((request) => {
      assert.equal(request.peer, 0);
      assert.equal(request.method, "thread/items/list");
      return {
        result:
          request.params?.cursor === undefined
            ? { data: [publicEntry("safe", "Prior safe page")], nextCursor: "malformed-page" }
            : {
                data: [
                  { turnId: "child-turn", item: { type: "agentMessage", id: "bad", text: 42 } },
                ],
                nextCursor: null,
              },
      };
    });
    const failure = yield* fixture.read.pipe(Effect.flip);
    assert.equal(failure._tag, "CodexAppServerRequestError");
    if (failure._tag === "CodexAppServerRequestError") assert.equal(failure.code, -32602);
    fixture.assertRetired(1);
  }),
);

it.effect(
  "preserves safe summary prose after a later fallback page exceeds its 1 MiB line cap",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTransportFixture((request) => {
        if (request.peer === 0) {
          assert.equal(request.method, "thread/items/list");
          return {
            result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null },
          };
        }
        assert.equal(request.peer, 1);
        assert.equal(request.method, "thread/turns/list");
        return {
          result:
            request.params?.cursor === undefined
              ? { ...summaryPage("Safe newest summary"), nextCursor: "oversized-summary" }
              : summaryPage("x".repeat(2 * MIB)),
        };
      });
      const snapshot = yield* fixture.read;
      assert.deepEqual(
        snapshot.publicHistory?.map((message) => message.text),
        ["Safe newest summary"],
      );
      assert.equal(snapshot.historyIncomplete, true);
      assert.equal(snapshot.activityHistoryIncomplete, true);
      fixture.assertRetired(2);
    }),
);

it.effect("does not open a third reader when fallback itself exceeds its first-page line cap", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTransportFixture((request) => {
      assert.ok(request.peer < 2);
      return request.peer === 0
        ? { result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null } }
        : { result: summaryPage("x".repeat(2 * MIB)) };
    });
    const failure = yield* fixture.read.pipe(Effect.flip);
    assert.equal(failure._tag, "CodexAppServerIncomingMessageTooLargeError");
    if (failure._tag === "CodexAppServerIncomingMessageTooLargeError") {
      assert.equal(failure.maxBytes, MIB);
    }
    fixture.assertRetired(2);
  }),
);

it.effect(
  "counts fallback metadata and private summary fields against its 4 MiB total budget",
  () =>
    Effect.gen(function* () {
      let summaryPages = 0;
      const fixture = yield* makeTransportFixture(
        (request) => {
          if (request.peer === 0) {
            assert.equal(request.method, "thread/items/list");
            return {
              result: { data: [commandEntry("oversized-first", 17 * MIB)], nextCursor: null },
            };
          }
          assert.equal(request.peer, 1);
          assert.equal(request.method, "thread/turns/list");
          summaryPages += 1;
          assert.ok(summaryPages <= 4);
          return {
            result: {
              data: [
                {
                  id: `summary-${summaryPages}`,
                  status: "completed",
                  itemsView: "summary",
                  items: [
                    publicEntry(`summary-public-${summaryPages}`, `Safe summary ${summaryPages}`)
                      .item,
                    commandEntry(`summary-private-${summaryPages}`, 900 * 1024).item,
                  ],
                },
              ],
              nextCursor: `next-summary-${summaryPages}`,
            },
          };
        },
        // Each metadata frame fits the summary line cap; together with four
        // individually admissible pages they exceed the scoped raw-byte budget.
        (thread) => ({ ...thread, preview: privateSentinel.padEnd(600 * 1024, "x") }),
      );
      const snapshot = yield* fixture.read;
      assert.equal(summaryPages, 4);
      assert.ok((fixture.peerWireBytes[1] ?? 0) > 4 * MIB);
      assert.deepEqual(
        snapshot.publicHistory?.map((message) => message.text),
        ["Safe summary 3", "Safe summary 2", "Safe summary 1"],
      );
      assert.deepEqual(snapshot.publicActivities, []);
      assert.equal(snapshot.historyIncomplete, true);
      assert.equal(snapshot.activityHistoryIncomplete, true);
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_HISTORY_OUTPUT|FORGED_PUBLIC/);
      fixture.assertRetired(2);
    }),
);
