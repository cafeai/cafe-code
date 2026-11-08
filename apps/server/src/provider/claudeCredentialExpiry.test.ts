import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import {
  makeClaudeCredentialExpiry,
  parseClaudeCredentialExpiry,
} from "./claudeCredentialExpiry.ts";

const observedAt = "2026-11-04T00:00:00.000Z";
const expiryA = "2026-11-10T00:00:00.000Z";
const expiryB = "2026-11-11T00:00:00.000Z";
const snapshot = (instance = "claude-owned"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instance),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.318",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: observedAt,
  models: [],
  slashCommands: [],
  skills: [],
});
const inertProvider = (value = snapshot()): ServerProviderShape => ({
  maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
    provider: value.driver,
    packageName: null,
  }),
  getSnapshot: Effect.succeed(value),
  getCurrentSnapshot: Effect.succeed(value),
  refresh: Effect.succeed(value),
  streamChanges: Stream.never,
});

describe("native Claude credential expiry", () => {
  it("normalizes finite ISO instants while refusing ambiguous dates and unbounded provider text", () => {
    for (const [input, expected] of [
      ["2026-11-10T00:00:00Z", expiryA],
      ["2026-11-10T09:00:00+09:00", expiryA],
      ["2028-02-29T12:34:56.125Z", "2028-02-29T12:34:56.125Z"],
    ])
      assert.strictEqual(parseClaudeCredentialExpiry(input), expected);
    for (const input of [
      undefined,
      null,
      1_800_000_000,
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-11-10T25:00:00Z",
      "2026-11-10T00:00:00+24:00",
      "November 10, 2026",
      "2026-11-10",
      "x".repeat(10_000),
    ])
      assert.isUndefined(parseClaudeCredentialExpiry(input));
  });

  it.effect(
    "keeps only live lease observations and fences stale indices, absence and retired owners",
    () =>
      Effect.gen(function* () {
        const state = yield* makeClaudeCredentialExpiry();
        const provider = state.decorate(inertProvider());
        const otherState = yield* makeClaudeCredentialExpiry();
        const otherProvider = otherState.decorate(inertProvider(snapshot("claude-other")));
        let oldLive = true;
        const old = yield* state.onOwner(() => oldLive);
        yield* old.observe({ resultIndex: 0, expiresAt: expiryA, observedAt });
        assert.deepStrictEqual((yield* provider.getCurrentSnapshot!).auth.credentialExpiry, {
          source: "native-result",
          expiresAt: expiryA,
          observedAt,
        });
        assert.isUndefined((yield* otherProvider.getCurrentSnapshot!).auth.credentialExpiry);
        yield* old.observe({ resultIndex: 0, expiresAt: expiryB, observedAt });
        assert.strictEqual(
          (yield* provider.getCurrentSnapshot!).auth.credentialExpiry?.expiresAt,
          expiryA,
        );
        yield* old.observe({ resultIndex: 2, expiresAt: undefined, observedAt });
        assert.isUndefined((yield* provider.getCurrentSnapshot!).auth.credentialExpiry);
        yield* old.observe({ resultIndex: 1, expiresAt: expiryB, observedAt });
        assert.isUndefined((yield* provider.getCurrentSnapshot!).auth.credentialExpiry);
        yield* old.observe({ resultIndex: 3, expiresAt: expiryA, observedAt });
        yield* old.observe({
          resultIndex: 4,
          expiresAt: undefined,
          observedAt: "invalid callback timestamp",
        });
        assert.strictEqual(
          (yield* provider.getCurrentSnapshot!).auth.credentialExpiry?.expiresAt,
          expiryA,
        );
        yield* old.observe({ resultIndex: 5, expiresAt: "private malformed date", observedAt });
        yield* old.observe({ resultIndex: 3, expiresAt: expiryB, observedAt });
        assert.deepStrictEqual((yield* provider.getCurrentSnapshot!).auth.credentialExpiry, {
          source: "native-result",
          expiresAt: expiryA,
          observedAt,
        });
        // The getter refuses the retired native owner immediately, before its
        // asynchronous retirement callback has had an opportunity to publish.
        oldLive = false;
        assert.isUndefined((yield* provider.getCurrentSnapshot!).auth.credentialExpiry);
        const replacement = yield* state.onOwner(() => true);
        yield* replacement.observe({ resultIndex: 0, expiresAt: expiryB, observedAt });
        yield* old.retire;
        oldLive = true;
        yield* old.observe({ resultIndex: 100, expiresAt: expiryA, observedAt });
        const current = yield* provider.getCurrentSnapshot!;
        assert.strictEqual(current.auth.credentialExpiry?.expiresAt, expiryB);
        assert.strictEqual(current.auth.status, "authenticated");
        assert.strictEqual(current.status, "ready");
        yield* replacement.retire;
        assert.isUndefined((yield* provider.getCurrentSnapshot!).auth.credentialExpiry);
      }).pipe(Effect.scoped),
  );

  it.effect("bounds live advisory owners without promoting omitted metadata as no-expiry", () =>
    Effect.gen(function* () {
      const state = yield* makeClaudeCredentialExpiry();
      const provider = state.decorate(inertProvider());
      const admitted = [];
      for (let index = 0; index < 64; index++) {
        const lease = yield* state.onOwner(() => true);
        yield* lease.observe({ resultIndex: 0, expiresAt: expiryB, observedAt });
        admitted.push(lease);
      }
      const overflow = yield* state.onOwner(() => true);
      yield* overflow.observe({ resultIndex: 0, expiresAt: expiryA, observedAt });
      assert.strictEqual(
        (yield* provider.getCurrentSnapshot!).auth.credentialExpiry?.expiresAt,
        expiryB,
      );
      yield* admitted[0]!.retire;
      yield* overflow.observe({ resultIndex: 1, expiresAt: expiryA, observedAt });
      assert.strictEqual(
        (yield* provider.getCurrentSnapshot!).auth.credentialExpiry?.expiresAt,
        expiryA,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "publishes advisory levels through the inert current getter without adding native probes",
    () =>
      Effect.gen(function* () {
        const state = yield* makeClaudeCredentialExpiry();
        const value = snapshot();
        const calls = { get: 0, refresh: 0, account: 0, usage: 0, models: 0, setUsage: 0 };
        const operation = (key: keyof typeof calls) =>
          Effect.sync(() => {
            calls[key]++;
            return value;
          });
        let receivedUsage: unknown;
        const native: ServerProviderShape = {
          ...inertProvider(value),
          getSnapshot: operation("get"),
          refresh: operation("refresh"),
          refreshAfterAccountChange: operation("account"),
          refreshAccountUsage: operation("usage"),
          refreshModels: operation("models"),
          setAccountUsage: (usage) =>
            Effect.sync(() => {
              receivedUsage = usage;
              calls.setUsage++;
              return value;
            }),
          // A real initial source value is the receiver admission receipt;
          // subsequent assertions await actual decorated stream deliveries.
          streamChanges: Stream.concat(Stream.make(value), Stream.never),
        };
        const provider = state.decorate(native);
        const received = yield* Queue.unbounded<ServerProvider>();
        const receiver = yield* provider.streamChanges.pipe(
          Stream.runForEach((next) => Queue.offer(received, next)),
          Effect.forkScoped({ startImmediately: true }),
        );
        assert.isUndefined((yield* Queue.take(received)).auth.credentialExpiry);
        let leaseLive = true;
        const lease = yield* state.onOwner(() => leaseLive);
        yield* lease.observe({ resultIndex: 0, expiresAt: expiryA, observedAt });
        assert.strictEqual((yield* Queue.take(received)).auth.credentialExpiry?.expiresAt, expiryA);
        assert.deepStrictEqual(calls, {
          get: 0,
          refresh: 0,
          account: 0,
          usage: 0,
          models: 0,
          setUsage: 0,
        });
        const usage = { checkedAt: observedAt, rateLimits: {} };
        for (const effect of [
          provider.getSnapshot,
          provider.refresh,
          provider.refreshAfterAccountChange!,
          provider.refreshAccountUsage!,
          provider.refreshModels!,
          provider.setAccountUsage!(usage),
        ])
          assert.strictEqual((yield* effect).auth.credentialExpiry?.expiresAt, expiryA);
        assert.strictEqual(receivedUsage, usage);
        assert.deepStrictEqual(calls, {
          get: 1,
          refresh: 1,
          account: 1,
          usage: 1,
          models: 1,
          setUsage: 1,
        });
        // Adapter retirement fences this predicate before awaited capability
        // cleanup. An independently live query can report unknown metadata in
        // that interval, pruning the old owner before its retire call runs.
        // The already-subscribed consumer must receive the cleared level even
        // though neither subsequent explicit retire removes an entry.
        leaseLive = false;
        const unknown = yield* state.onOwner(() => true);
        yield* unknown.observe({ resultIndex: 0, expiresAt: undefined, observedAt });
        yield* lease.retire;
        yield* unknown.retire;
        assert.isUndefined((yield* Queue.take(received)).auth.credentialExpiry);
        assert.deepStrictEqual(calls, {
          get: 1,
          refresh: 1,
          account: 1,
          usage: 1,
          models: 1,
          setUsage: 1,
        });
        yield* Fiber.interrupt(receiver);
      }).pipe(Effect.scoped),
  );
});
