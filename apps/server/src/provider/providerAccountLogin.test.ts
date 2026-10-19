import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type ServerProvider,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import { makeProviderRegistryLive } from "./Layers/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderAdapterValidationError } from "./Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { loginBoundProviderAccount } from "./providerAccountLogin.ts";

const fixture = Effect.fn("accountLogin.fixture")(function* (driver = "axiom") {
  const instanceId = ProviderInstanceId.make(`${driver}_work`);
  const kind = ProviderDriverKind.make(driver);
  const completed = yield* Deferred.make<void>();
  const refreshed = yield* Deferred.make<void>();
  const scope = yield* Effect.scope;
  const state = { authenticated: false, starts: 0, probes: 0 };
  const baseline: ServerProvider = {
    instanceId,
    driver: kind,
    enabled: true,
    installed: true,
    version: "fixture",
    status: "warning",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-10-18T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const snapshot = yield* makeManagedServerProvider({
    maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
      provider: kind,
      packageName: null,
    }),
    getSettings: Effect.succeed({}),
    streamSettings: Stream.never,
    haveSettingsChanged: () => false,
    initialSnapshot: () => Effect.succeed(baseline),
    checkProvider: Effect.sync((): ServerProvider => {
      state.probes++;
      return state.authenticated
        ? { ...baseline, status: "ready", auth: { status: "authenticated" } }
        : baseline;
    }),
    refreshInterval: "5 minutes",
    probePolicy: { initialRefresh: "external" },
  });
  const login: NonNullable<ProviderInstance["adapter"]["login"]> = (
    hasSessions = Effect.succeed(false),
  ) =>
    Effect.gen(function* () {
      if (
        yield* hasSessions.pipe(
          Effect.mapError(
            () =>
              new ProviderAdapterValidationError({
                provider: kind,
                operation: "login",
                issue: "inventory unavailable",
              }),
          ),
        )
      )
        return yield* new ProviderAdapterValidationError({
          provider: kind,
          operation: "login",
          issue: "busy",
        });
      state.starts++;
      yield* Deferred.await(completed).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.authenticated = true;
          }),
        ),
        Effect.andThen(snapshot.refreshAfterAccountChange ?? snapshot.refresh),
        Effect.andThen(Deferred.succeed(refreshed, undefined)),
        Effect.forkIn(scope),
      );
      return "started" as const;
    });
  const instance: ProviderInstance = {
    instanceId,
    driverKind: kind,
    enabled: true,
    displayName: "Work",
    continuationIdentity: { driverKind: kind, continuationKey: `fixture:${instanceId}` },
    snapshot,
    adapter: { login } as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  const session = {
    provider: kind,
    providerInstanceId: instanceId,
    threadId: ThreadId.make("live-daemon-chat"),
  } as ProviderSession;
  return { instance, completed, refreshed, state, session };
});

describe("backend-owned account login", () => {
  for (const driver of ["axiom", "codex"]) {
    it.effect(
      `publishes ${driver} login completion through the backend registry without manual refresh`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(driver);
          const changes = yield* PubSub.unbounded<void>();
          const context = yield* Layer.build(
            makeProviderRegistryLive({ statusCache: "disabled" }).pipe(
              Layer.provide(
                Layer.succeed(ProviderInstanceRegistry, {
                  getInstance: () => Effect.succeed(f.instance),
                  listInstances: Effect.succeed([f.instance]),
                  listUnavailable: Effect.succeed([]),
                  streamChanges: Stream.fromPubSub(changes),
                  subscribeChanges: PubSub.subscribe(changes),
                }),
              ),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "cafe-account-login-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          );
          const registry = Context.get(context, ProviderRegistry);
          const nextUpdate = yield* Stream.toPull(registry.streamChanges);
          expect((yield* registry.getProviders)[0]?.auth.status).toBe("unauthenticated");
          expect(
            (yield* registry.loginProvider!(
              { instanceId: f.instance.instanceId },
              Effect.succeed([]),
            )).outcome,
          ).toBe("started");
          expect(f.state.starts).toBe(1);
          expect((yield* registry.getProviders)[0]?.auth.status).toBe("unauthenticated");
          yield* Deferred.succeed(f.completed, undefined);
          const updates = yield* nextUpdate;
          expect(
            updates.some((providers) =>
              providers.some(
                (provider) =>
                  provider.instanceId === f.instance.instanceId &&
                  provider.auth.status === "authenticated",
              ),
            ),
          ).toBe(true);
          yield* Deferred.await(f.refreshed);
          expect((yield* registry.getProviders)[0]?.auth.status).toBe("authenticated");
          expect(f.state.starts).toBe(1);
          expect(f.state.probes).toBe(2);
        }),
    );
  }

  it.effect("retains the real daemon's same-account session fence", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(
        yield* loginBoundProviderAccount({
          instanceId: f.instance.instanceId,
          getInstance: () => Effect.succeed(f.instance),
          listSessions: Effect.succeed([f.session]),
        }).pipe(Effect.flip),
      ).toMatchObject({ issue: "busy" });
      expect(f.state.starts).toBe(0);
    }),
  );

  it.effect("does not confuse another explicit account with this account", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* loginBoundProviderAccount({
        instanceId: f.instance.instanceId,
        getInstance: () => Effect.succeed(f.instance),
        listSessions: Effect.succeed([
          { ...f.session, providerInstanceId: ProviderInstanceId.make("other-account") },
        ]),
      });
      expect(result.outcome).toBe("started");
      expect(f.state.starts).toBe(1);
    }),
  );

  it.effect("refuses legacy same-driver sessions whose exact account is unknown", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { providerInstanceId: _id, ...legacy } = f.session;
      expect(
        yield* loginBoundProviderAccount({
          instanceId: f.instance.instanceId,
          getInstance: () => Effect.succeed(f.instance),
          listSessions: Effect.succeed([legacy]),
        }).pipe(Effect.flip),
      ).toMatchObject({ issue: "busy" });
      expect(f.state.starts).toBe(0);
    }),
  );

  it.effect("refuses a replaced account after awaiting remote inventory", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let current = f.instance;
      const fiber = yield* loginBoundProviderAccount({
        instanceId: f.instance.instanceId,
        getInstance: () => Effect.succeed(current),
        listSessions: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as([]),
        ),
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      current = { ...f.instance };
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toMatchObject({ operation: "login" });
      expect(f.state.starts).toBe(0);
    }),
  );

  it.effect("does not start native login after an inconclusive daemon inventory", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* loginBoundProviderAccount({
        instanceId: f.instance.instanceId,
        getInstance: () => Effect.succeed(f.instance),
        listSessions: Effect.die(new Error("inconclusive private daemon")),
      }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(f.state.starts).toBe(0);
    }),
  );
});
