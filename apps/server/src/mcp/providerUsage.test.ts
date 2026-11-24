import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { readProviderAccountQuotaReports } from "./providerUsage.ts";

const provider = (id: string) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    auth: { status: "authenticated" },
  }) as ServerProvider;
const report = {
  source: "claude-cli" as const,
  observedAt: "2026-11-15T00:00:00.000Z",
  meters: [],
};

describe("provider account quota admission", () => {
  it.effect(
    "keeps interrupted, failed and stale reads unknown without hiding another account",
    () =>
      Effect.gen(function* () {
        const reports = yield* readProviderAccountQuotaReports(
          ["a-interrupted", "b-failed", "c-stale", "d-available"].map(provider),
          (id) =>
            id === "a-interrupted"
              ? Effect.interrupt
              : id === "b-failed"
                ? Effect.die("PRIVATE_NATIVE_FAILURE")
                : Effect.succeed({ report, ...(id === "c-stale" ? { stale: true as const } : {}) }),
        );
        expect(reports.size).toBe(4);
        for (const id of ["a-interrupted", "b-failed", "c-stale"])
          expect(reports.get(ProviderInstanceId.make(id))).toEqual({
            status: "unknown",
            report: null,
          });
        expect(reports.get(ProviderInstanceId.make("d-available"))).toMatchObject({
          status: "reported",
          report: { source: "claude-cli", meters: [] },
        });
      }),
  );

  it.effect(
    "bounds native reads and retains completed accounts while joining timed-out owners",
    () =>
      Effect.gen(function* () {
        const twoStarted = yield* Deferred.make<void>();
        const calls: string[] = [];
        let active = 0;
        let closed = 0;
        let isCurrent = true;
        const read = (id: ProviderInstanceId) => {
          if (id === "a-completed") return Effect.succeed({ report });
          if (id === "a-retired") return Effect.succeed({ report, isCurrent: () => isCurrent });
          return Effect.acquireUseRelease(
            Effect.gen(function* () {
              calls.push(id);
              active++;
              if (active === 2) yield* Deferred.succeed(twoStarted, undefined);
            }),
            () => Effect.never,
            () =>
              Effect.sync(() => {
                active--;
                closed++;
              }),
          );
        };
        const fiber = yield* readProviderAccountQuotaReports(
          ["a-completed", "a-retired", "b-held", "c-held", "d-queued"].map(provider),
          read,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(twoStarted);
        expect(active).toBe(2);
        isCurrent = false;
        yield* TestClock.adjust("15 seconds");
        const reports = yield* Fiber.join(fiber);
        expect(reports.get(ProviderInstanceId.make("a-completed"))).toEqual({
          status: "reported",
          report: { ...report, meters: [] },
        });
        expect(reports.get(ProviderInstanceId.make("a-retired"))).toEqual({
          status: "unknown",
          report: null,
        });
        expect(calls).toEqual(["b-held", "c-held"]);
        expect(active).toBe(0);
        expect(closed).toBe(2);
        expect(reports.size).toBe(2);
      }),
  );

  it.effect(
    "caller cancellation joins admitted reads before returning and never admits queued accounts",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let active = 0;
        let closed = 0;
        let calls = 0;
        const fiber = yield* readProviderAccountQuotaReports(["a", "b", "c"].map(provider), () =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              calls++;
              active++;
              if (active === 2) yield* Deferred.succeed(started, undefined);
            }),
            () => Effect.never,
            () =>
              Effect.sync(() => {
                active--;
                closed++;
              }),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(calls).toBe(2);
        expect(active).toBe(0);
        expect(closed).toBe(2);
      }),
  );
});
