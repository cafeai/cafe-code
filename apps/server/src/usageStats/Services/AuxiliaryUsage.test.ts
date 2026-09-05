import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { ProviderDriverKind, type UsageAccountingSnapshot } from "@cafecode/contracts";
import { AuxiliaryUsage, AuxiliaryUsageLive } from "./AuxiliaryUsage.ts";

const snapshot: UsageAccountingSnapshot = {
  scopeId: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  completeness: "complete",
  models: [
    {
      model: "unknown",
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 1,
    },
  ],
};
const provider = ProviderDriverKind.make("codex");

it.effect("awaits a late installed scoped sink and keeps the original observation time", () =>
  Effect.gen(function* () {
    const service = yield* AuxiliaryUsage;
    const recorded: Array<unknown> = [];
    const pending = yield* service.record(provider, snapshot, 123).pipe(Effect.forkChild);
    yield* service.installSink((provider, value, observedAtMs) =>
      Effect.sync(() => recorded.push({ provider, value, observedAtMs })),
    );
    yield* Fiber.join(pending);
    expect(recorded).toEqual([{ provider: "codex", value: snapshot, observedAtMs: 123 }]);
  }).pipe(Effect.provide(AuxiliaryUsageLive)),
);

it.effect("validates snapshots and does not replace an installed sink", () =>
  Effect.gen(function* () {
    const service = yield* AuxiliaryUsage;
    let calls = 0;
    yield* service.installSink(() =>
      Effect.sync(() => {
        calls += 1;
      }),
    );
    yield* service.installSink(() => Effect.die("must not replace the runtime owner"));
    yield* service.record(provider, { ...snapshot, scopeId: "raw provider identity" }, 123);
    expect(calls).toBe(0);
    yield* service.record(provider, snapshot, 123);
    expect(calls).toBe(1);
  }).pipe(Effect.provide(AuxiliaryUsageLive)),
);

it.effect("does not expose a failed accounting sink as a generation failure", () =>
  Effect.gen(function* () {
    const service = yield* AuxiliaryUsage;
    yield* service.installSink(() => Effect.die("sensitive failure detail"));
    yield* service.record(provider, snapshot, 123);
  }).pipe(Effect.provide(AuxiliaryUsageLive)),
);

it.effect("bounds missing sink acknowledgement and does not queue an abandoned record", () =>
  Effect.gen(function* () {
    const service = yield* AuxiliaryUsage;
    const pending = yield* service.record(provider, snapshot, 123).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(pending);
    let calls = 0;
    yield* service.installSink(() =>
      Effect.sync(() => {
        calls += 1;
      }),
    );
    expect(calls).toBe(0);
  }).pipe(Effect.provide(AuxiliaryUsageLive)),
);
