import assert from "node:assert/strict";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, it } from "vitest";

import {
  CODEX_REWIND_MAX_PAGES,
  CODEX_REWIND_PAGE_SIZE,
  rewindCodexThreadWithClient,
  type CodexThreadRewindClient,
} from "./CodexThreadRewind.ts";

function metadata(historyMode: "legacy" | "paginated" = "paginated") {
  return {
    thread: {
      cliVersion: "0.155.0",
      createdAt: 1,
      cwd: "/workspace",
      ephemeral: false,
      historyMode,
      id: "thread-1",
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 1,
    },
  } satisfies CodexSchema.V2ThreadReadResponse;
}

function turn(id: string, status: "completed" | "inProgress" = "completed") {
  return { id, status, itemsView: "notLoaded", items: [] } as const;
}

function harness(
  response: (method: string, payload: unknown, call: number) => unknown,
  rawResponse: unknown = metadata("legacy"),
) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const client = {
    request: ((method: string, payload: unknown) =>
      Effect.suspend(() => {
        calls.push({ method, payload });
        const result = response(method, payload, calls.length);
        return Effect.isEffect(result) ? result : Effect.succeed(result);
      })) as CodexThreadRewindClient["request"],
    raw: {
      request: (method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          return rawResponse;
        }),
    } as CodexThreadRewindClient["raw"],
  };
  return {
    calls,
    run: (numTurns: number) =>
      rewindCodexThreadWithClient({ client, providerThreadId: "thread-1", numTurns }),
  };
}

function ordinaryResponse(method: string) {
  if (method === "thread/read") return metadata();
  if (method === "thread/goal/get") return { goal: null };
  if (method === "thread/revert") {
    return { ...metadata(), turnsBackwardsCursor: "retained-cursor", itemsBackwardsCursor: null };
  }
  throw new Error(`Unexpected test method: ${method}`);
}

describe("Codex native rewind compatibility", () => {
  it("selects the exact native cutoff across bounded metadata-only pages", async () => {
    let page = 0;
    const test = harness((method) => {
      if (method !== "thread/turns/list") return ordinaryResponse(method);
      page += 1;
      return page === 1
        ? {
            data: Array.from({ length: CODEX_REWIND_PAGE_SIZE }, (_, i) => turn(`recent-${i}`)),
            nextCursor: "older-cursor",
          }
        : {
            data: [turn(page === 2 ? "exact-cutoff" : page === 3 ? "retained-tail" : "recent-0")],
            nextCursor: "retained-cursor",
          };
    });
    const result = await Effect.runPromise(test.run(CODEX_REWIND_PAGE_SIZE + 1));
    assert.deepEqual(result.thread.turns, []);
    assert.deepEqual(
      test.calls.filter(({ method }) => method === "thread/turns/list"),
      [
        {
          method: "thread/turns/list",
          payload: {
            threadId: "thread-1",
            sortDirection: "desc",
            itemsView: "notLoaded",
            limit: 64,
          },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "thread-1",
            sortDirection: "desc",
            itemsView: "notLoaded",
            limit: 1,
            cursor: "older-cursor",
          },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "thread-1",
            sortDirection: "desc",
            itemsView: "notLoaded",
            limit: 1,
            cursor: "retained-cursor",
          },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "thread-1",
            sortDirection: "desc",
            itemsView: "notLoaded",
            limit: 1,
          },
        },
      ],
    );
    assert.deepEqual(test.calls.at(-1), {
      method: "thread/revert",
      payload: { threadId: "thread-1", beforeTurnId: "exact-cutoff" },
    });
    assert.equal(test.calls.filter(({ method }) => method === "thread/read").length, 2);
    assert.equal(test.calls.filter(({ method }) => method === "thread/goal/get").length, 2);
    assert.equal(
      test.calls.some(({ method }) => method === "thread/rollback"),
      false,
    );
  });

  it("preserves the old rollback operation for an observed legacy history", async () => {
    const test = harness(() => metadata("legacy"));
    await Effect.runPromise(test.run(2));
    assert.deepEqual(test.calls, [
      { method: "thread/read", payload: { threadId: "thread-1", includeTurns: false } },
      { method: "thread/rollback", payload: { threadId: "thread-1", numTurns: 2 } },
    ]);
  });

  it("does not retry or change operations after an ambiguous native mutation failure", async () => {
    const failure = new CodexErrors.CodexAppServerTransportError({
      detail: "disconnected",
      cause: "synthetic test failure",
    });
    const test = harness((method) => {
      if (method === "thread/revert") return Effect.fail(failure);
      if (method === "thread/turns/list") return { data: [turn("cutoff")], nextCursor: null };
      return ordinaryResponse(method);
    });
    const result = await Effect.runPromise(Effect.flip(test.run(1)));
    assert.equal(result._tag, "ProviderAdapterRewindOutcomeUnknownError");
    assert.equal(test.calls.filter(({ method }) => method === "thread/revert").length, 1);
    assert.equal(
      test.calls.some(({ method }) => method === "thread/rollback"),
      false,
    );
    assert.equal(test.calls.at(-1)?.method, "thread/turns/list");
  });

  function failedMutationHarness(input: {
    readonly after: ReadonlyArray<string>;
    readonly failure?: CodexErrors.CodexAppServerError;
    readonly reconciliationRead?: "fail" | "hang" | "wrong-thread";
  }) {
    let mutated = false;
    const original = ["latest", "cutoff", "retained", "older"];
    return harness((method, payload) => {
      if (method === "thread/revert") {
        mutated = true;
        return Effect.fail(
          input.failure ?? CodexErrors.CodexAppServerRequestError.internalError("reload failed"),
        );
      }
      if (mutated && method === "thread/read") {
        if (input.reconciliationRead === "fail") {
          return Effect.fail(CodexErrors.CodexAppServerRequestError.internalError("read failed"));
        }
        if (input.reconciliationRead === "hang") return Effect.never;
        if (input.reconciliationRead === "wrong-thread") {
          return { thread: { ...metadata().thread, id: "other-thread" } };
        }
      }
      if (method !== "thread/turns/list") return ordinaryResponse(method);
      const params = payload as { cursor?: string; limit: number };
      const history = mutated ? input.after : original;
      const start = params.cursor ? Number(params.cursor) : 0;
      const end = Math.min(start + params.limit, history.length);
      return {
        data: history.slice(start, end).map((id) => turn(id)),
        nextCursor: end < history.length ? String(end) : null,
      };
    });
  }

  it("accepts an exact retained prefix after native commit followed by a reload error", async () => {
    const test = failedMutationHarness({ after: ["retained", "older"] });
    const result = await Effect.runPromise(test.run(2));
    assert.equal(result.thread.id, "thread-1");
    assert.deepEqual(result.thread.turns, []);
    assert.equal(test.calls.filter(({ method }) => method === "thread/revert").length, 1);
    assert.equal(
      test.calls.some(({ method }) => method === "thread/rollback"),
      false,
    );
  });

  it("reconciles an empty retained prefix when all original turns were removed", async () => {
    const test = failedMutationHarness({ after: [] });
    const result = await Effect.runPromise(test.run(4));
    assert.equal(result.thread.id, "thread-1");
    assert.equal(test.calls.filter(({ method }) => method === "thread/revert").length, 1);
  });

  it("permits compensation only after an explicit rejection and exact unchanged tail", async () => {
    const test = failedMutationHarness({ after: ["latest", "cutoff", "retained", "older"] });
    const error = await Effect.runPromise(Effect.flip(test.run(2)));
    assert.equal(error._tag, "CodexAppServerRequestError");
    assert.match(error.message, /verified unchanged/);
    assert.equal(test.calls.filter(({ method }) => method === "thread/revert").length, 1);
  });

  it.each([
    ["older"],
    ["unrelated", "retained", "older"],
    ["latest", "changed-cutoff", "retained", "older"],
    [],
  ])("retains an uncertain mutation outcome for a different tail %j", async (...after) => {
    const test = failedMutationHarness({ after });
    const error = await Effect.runPromise(Effect.flip(test.run(2)));
    assert.equal(error._tag, "ProviderAdapterRewindOutcomeUnknownError");
    assert.equal(test.calls.filter(({ method }) => method === "thread/revert").length, 1);
  });

  it("does not call a transport-failed mutation unchanged while it may still settle", async () => {
    const test = failedMutationHarness({
      after: ["latest", "cutoff", "retained", "older"],
      failure: new CodexErrors.CodexAppServerTransportError({
        detail: "private-failure-sentinel",
        cause: "private-cause-sentinel",
      }),
    });
    const error = await Effect.runPromise(Effect.flip(test.run(2)));
    assert.equal(error._tag, "ProviderAdapterRewindOutcomeUnknownError");
    assert.doesNotMatch(JSON.stringify(error), /private-/);
  });

  it.each(["fail", "wrong-thread"] as const)(
    "fails closed when reconciliation cannot establish native identity: %s",
    async (reconciliationRead) => {
      const test = failedMutationHarness({ after: ["retained", "older"], reconciliationRead });
      const error = await Effect.runPromise(Effect.flip(test.run(2)));
      assert.equal(error._tag, "ProviderAdapterRewindOutcomeUnknownError");
    },
  );

  effectIt.effect("bounds post-error read-only reconciliation without retrying mutation", () =>
    Effect.gen(function* () {
      const test = failedMutationHarness({
        after: ["retained", "older"],
        reconciliationRead: "hang",
      });
      const fiber = yield* test.run(2).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "ProviderAdapterRewindOutcomeUnknownError");
      assert.equal(test.calls.filter(({ method }) => method === "thread/revert").length, 1);
    }),
  );

  it.each([
    "active",
    "notLoaded",
    "systemError",
    "wrong-thread",
    "active-goal",
    "usage-limited-goal",
    "racing-goal",
    "racing-turn",
  ])("refuses rewind without verified idle ownership: %s", async (scenario) => {
    let reads = 0;
    let goals = 0;
    const test = harness((method) => {
      if (method === "thread/read") {
        reads += 1;
        const response = metadata();
        return {
          thread: {
            ...response.thread,
            id: scenario === "wrong-thread" ? "other-thread" : "thread-1",
            status: {
              type:
                scenario === "racing-turn" && reads === 2
                  ? "active"
                  : ["active", "notLoaded", "systemError"].includes(scenario)
                    ? scenario
                    : "idle",
            },
          },
        };
      }
      if (method === "thread/goal/get") {
        goals += 1;
        return {
          goal:
            scenario === "active-goal" ||
            scenario === "usage-limited-goal" ||
            (scenario === "racing-goal" && goals === 2)
              ? { status: scenario === "usage-limited-goal" ? "usageLimited" : "active" }
              : null,
        };
      }
      if (method === "thread/turns/list") return { data: [turn("cutoff")], nextCursor: null };
      return ordinaryResponse(method);
    });
    await Effect.runPromise(Effect.flip(test.run(1)));
    assert.equal(
      test.calls.some(({ method }) => ["thread/revert", "thread/rollback"].includes(method)),
      false,
    );
  });

  it.each([
    "duplicate-turn",
    "blank-turn",
    "running-turn",
    "oversized-page",
    "exhausted",
    "repeated-cursor",
    "page-limit",
  ])("rejects unsafe history before any mutation: %s", async (scenario) => {
    let page = 0;
    const test = harness((method) => {
      if (method !== "thread/turns/list") return ordinaryResponse(method);
      page += 1;
      if (scenario === "exhausted") return { data: [], nextCursor: null };
      if (scenario === "oversized-page") {
        return { data: Array.from({ length: 65 }, (_, i) => turn(`turn-${i}`)), nextCursor: null };
      }
      return {
        data: [
          turn(
            scenario === "blank-turn"
              ? ""
              : scenario === "duplicate-turn"
                ? "duplicate"
                : `turn-${page}`,
            scenario === "running-turn" ? "inProgress" : "completed",
          ),
        ],
        nextCursor: scenario === "repeated-cursor" ? "repeat" : `cursor-${page}`,
      };
    });
    await Effect.runPromise(Effect.flip(test.run(1_000)));
    assert.equal(
      test.calls.some(({ method }) => ["thread/revert", "thread/rollback"].includes(method)),
      false,
    );
    if (scenario === "page-limit") assert.equal(page, CODEX_REWIND_MAX_PAGES);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid count %s without I/O",
    async (count) => {
      const test = harness(ordinaryResponse);
      await Effect.runPromise(Effect.flip(test.run(count)));
      assert.deepEqual(test.calls, []);
    },
  );

  it("refuses a changed latest turn even when the provider became idle again", async () => {
    let pages = 0;
    const test = harness((method) => {
      if (method !== "thread/turns/list") return ordinaryResponse(method);
      pages += 1;
      return { data: [turn(pages === 1 ? "original-latest" : "newer-turn")], nextCursor: null };
    });
    await Effect.runPromise(Effect.flip(test.run(1)));
    assert.equal(
      test.calls.some(({ method }) => method === "thread/revert"),
      false,
    );
  });

  effectIt.effect("bounds a stalled history preflight without issuing a mutation", () =>
    Effect.gen(function* () {
      const test = harness((method) =>
        method === "thread/turns/list" ? Effect.never : ordinaryResponse(method),
      );
      const fiber = yield* test.run(1).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      assert.match(error.message, /lookup timed out/);
      assert.equal(
        test.calls.some(({ method }) => method === "thread/revert"),
        false,
      );
    }),
  );

  for (const stalledCall of [1, 2, 4, 5, 6]) {
    effectIt.effect(`bounds stalled preflight read ${stalledCall} before any mutation`, () =>
      Effect.gen(function* () {
        const test = harness((method, _payload, call) => {
          if (call === stalledCall) return Effect.never;
          if (method === "thread/turns/list") return { data: [turn("cutoff")], nextCursor: null };
          return ordinaryResponse(method);
        });
        const fiber = yield* test.run(1).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const error = yield* Fiber.join(fiber);
        assert.match(error.message, /lookup timed out/);
        assert.equal(test.calls.length, stalledCall);
        assert.equal(
          test.calls.some(({ method }) => ["thread/revert", "thread/rollback"].includes(method)),
          false,
        );
      }),
    );
  }

  effectIt.effect("shares one deadline across initial and final preflight reads", () =>
    Effect.gen(function* () {
      const test = harness((method, _payload, call) => {
        if (method === "thread/turns/list") return { data: [turn("cutoff")], nextCursor: null };
        const response = ordinaryResponse(method);
        return call === 1 || call === 4
          ? Effect.sleep("20 seconds").pipe(Effect.as(response))
          : response;
      });
      const fiber = yield* test.run(1).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      assert.match(error.message, /lookup timed out/);
      assert.equal(test.calls.at(-1)?.method, "thread/read");
      assert.equal(test.calls.length, 4);
    }),
  );

  it("sanitizes malformed legacy responses without retaining provider content", async () => {
    const test = harness(() => metadata("legacy"), { thread: "private-response-sentinel" });
    const error = await Effect.runPromise(Effect.flip(test.run(1)));
    assert.equal(error._tag, "CodexAppServerProtocolParseError");
    assert.doesNotMatch(JSON.stringify(error), /private-response-sentinel/);
  });
});
