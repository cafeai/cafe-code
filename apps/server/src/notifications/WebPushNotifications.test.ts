import { withSessionAdmission } from "../auth/sessionAdmission.ts";
// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, writeFile, chmod, stat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { describe, expect, it, vi } from "vitest";
import { AuthSessionId } from "@cafecode/contracts/auth";
import { ThreadId } from "@cafecode/contracts";
import { writePrivatePushState } from "./privateState.ts";
import {
  SessionCredentialService,
  SessionCredentialError,
  type SessionCredentialChange,
} from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ScheduledFollowups } from "../scheduledFollowups/service.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  makeWebPushNotifications,
  type WebPushNotificationsShape,
  type WebPushNotificationsError,
} from "./WebPushNotifications.ts";

const send = vi.hoisted(() => vi.fn(async () => ({ statusCode: 201 })));
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "public", privateKey: "private" }),
    sendNotification: send,
  },
}));
const subscription = {
  endpoint: "https://push.example/one",
  keys: { auth: "secret-auth", p256dh: "secret-key" },
};
const owner = {
  sessionId: AuthSessionId.make("session-one"),
  subject: "subject",
  method: "browser-session-cookie" as const,
  role: "client" as const,
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
};

async function fixture(
  task: (input: {
    root: string;
    service: WebPushNotificationsShape;
    restart: () => Effect.Effect<WebPushNotificationsShape, WebPushNotificationsError>;
    complete: () => Effect.Effect<void>;
    revoke: () => Effect.Effect<void>;
  }) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  send.mockClear();
  const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-push-owner-")));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* PubSub.unbounded<SessionCredentialChange>();
          const completions = yield* PubSub.unbounded<{
            type: "turn.completed";
            threadId: ThreadId;
          }>();
          const active = new Set([owner.sessionId]);
          const serviceEffect = makeWebPushNotifications.pipe(
            Effect.provideService(ServerConfig, { stateDir: root } as never),
            Effect.provideService(SessionCredentialService, {
              validateActiveSession: (identity: typeof owner) =>
                Effect.suspend(() =>
                  active.has(identity.sessionId)
                    ? Effect.void
                    : Effect.fail(new SessionCredentialError({ message: "Revoked" })),
                ),
              streamChanges: Stream.fromPubSub(changes),
            } as never),
            Effect.provideService(ProviderService, {
              streamEvents: Stream.fromPubSub(completions),
            } as never),
            Effect.provideService(ScheduledFollowups, {
              notification: () => Effect.succeed({ notify: true }),
            } as never),
            Effect.provideService(ProjectionSnapshotQuery, {
              getThreadShellById: () => Effect.succeed(Option.some({ title: "Synthetic thread" })),
            } as never),
            Effect.provideService(ServerEnvironment, {
              getDescriptor: Effect.succeed({ environmentId: "fixture" }),
            } as never),
            Effect.provide(NodeServices.layer),
          );
          const service = yield* serviceEffect;
          yield* task({
            root,
            service,
            restart: () => serviceEffect,
            complete: () =>
              PubSub.publish(completions, {
                type: "turn.completed" as const,
                threadId: ThreadId.make("fixture"),
              }).pipe(Effect.asVoid),
            revoke: () =>
              withSessionAdmission(Effect.sync(() => active.clear())).pipe(
                Effect.andThen(
                  PubSub.publish(changes, { type: "clientRemoved", sessionId: owner.sessionId }),
                ),
                Effect.asVoid,
              ),
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("session-owned Web Push", () => {
  it("refuses oversized UTF-8 state before replacing the last restartable identity", async () => {
    await fixture(({ root, service, restart }) =>
      Effect.gen(function* () {
        const publicKey = yield* service.getPublicKey();
        const state = join(root, "web-push.json");
        const previous = yield* Effect.promise(() => readFile(state, "utf8"));
        const oversized = JSON.stringify({
          vapid: { publicKey, privateKey: "é".repeat(512 * 1024) },
          subscriptions: [],
        });
        expect(oversized.length).toBeLessThan(1024 * 1024);
        yield* Effect.promise(() =>
          expect(writePrivatePushState(state, oversized, previous)).rejects.toThrow(
            "storage limit",
          ),
        );
        expect(yield* Effect.promise(() => readFile(state, "utf8"))).toBe(previous);
        expect(yield* (yield* restart()).getPublicKey()).toBe(publicKey);
      }),
    );
  });

  it("allows revocation to finish while an already admitted remote push is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<{ statusCode: number }>((resolve) => {
      finish = () => resolve({ statusCode: 201 });
    });
    send.mockImplementationOnce(() => pending);
    try {
      await fixture(({ root, service, complete, revoke }) =>
        Effect.gen(function* () {
          yield* service.getPublicKey();
          yield* service.saveSubscription({ owner, subscription });
          yield* service.start();
          yield* Effect.yieldNow;
          yield* complete();
          yield* Effect.promise(() => vi.waitFor(() => expect(send).toHaveBeenCalledOnce()));
          yield* revoke();
          yield* Effect.promise(() =>
            vi.waitFor(async () =>
              expect(
                JSON.parse(await readFile(join(root, "web-push.json"), "utf8")).subscriptions,
              ).toEqual([]),
            ),
          );
          yield* complete();
          finish();
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(send).toHaveBeenCalledOnce();
        }),
      );
    } finally {
      finish();
    }
  });
  it("preserves malformed state as recovery evidence instead of resetting identity", async () => {
    await fixture(({ root, restart }) =>
      Effect.gen(function* () {
        const state = join(root, "web-push.json");
        yield* Effect.promise(() => writeFile(state, "malformed private state"));
        expect(yield* Effect.exit(restart())).toHaveProperty("_tag", "Failure");
        expect(yield* Effect.promise(() => readFile(state, "utf8"))).toBe(
          "malformed private state",
        );
      }),
    );
  });

  it("retains exact owners across restart and refuses another session's endpoint or locale", async () => {
    await fixture(({ root, service, restart }) =>
      Effect.gen(function* () {
        yield* service.getPublicKey();
        yield* service.saveSubscription({ owner, subscription });
        const foreign = { ...owner, sessionId: AuthSessionId.make("foreign") };
        expect(
          yield* Effect.exit(service.saveSubscription({ owner: foreign, subscription })),
        ).toHaveProperty("_tag", "Failure");
        yield* service.updateSubscriptionLocale({ ...subscription, uiLocale: "ja" }, foreign);
        yield* service.removeSubscription(subscription.endpoint, foreign);
        const restarted = yield* restart();
        yield* restarted.updateSubscriptionLocale({ ...subscription, uiLocale: "ko" }, owner);
        const stored = JSON.parse(
          yield* Effect.promise(() => readFile(join(root, "web-push.json"), "utf8")),
        );
        expect(stored.subscriptions).toHaveLength(1);
        expect(stored.subscriptions[0].owner.sessionId).toBe(owner.sessionId);
        expect(stored.subscriptions[0].uiLocale).toBe("ko");
        if (process.platform !== "win32") {
          expect((yield* Effect.promise(() => stat(root))).mode & 0o777).toBe(0o700);
          expect(
            (yield* Effect.promise(() => stat(join(root, "web-push.json")))).mode & 0o777,
          ).toBe(0o600);
        }
      }),
    );
  });
  it("drops legacy unowned subscriptions while retaining VAPID identity and repairing permissions", async () => {
    await fixture(({ root, restart }) =>
      Effect.gen(function* () {
        const state = join(root, "web-push.json");
        yield* Effect.promise(() =>
          writeFile(
            state,
            JSON.stringify({
              vapid: { publicKey: "old-public", privateKey: "old-private" },
              subscriptions: [{ ...subscription, createdAt: "2026-01-01" }],
            }),
          ),
        );
        if (process.platform !== "win32") yield* Effect.promise(() => chmod(state, 0o644));
        const migrated = yield* restart();
        expect(yield* migrated.getPublicKey()).toBe("old-public");
        const stored = JSON.parse(yield* Effect.promise(() => readFile(state, "utf8")));
        expect(stored.subscriptions).toEqual([]);
      }),
    );
  });
  it("rejects registration and new delivery after revocation, removing persisted owners", async () => {
    await fixture(({ root, service, complete, revoke }) =>
      Effect.gen(function* () {
        yield* service.getPublicKey();
        yield* service.saveSubscription({ owner, subscription });
        yield* service.start();
        yield* Effect.yieldNow;
        yield* complete();
        yield* Effect.promise(() => vi.waitFor(() => expect(send).toHaveBeenCalledOnce()));
        yield* revoke();
        yield* Effect.promise(() =>
          vi.waitFor(async () =>
            expect(
              JSON.parse(await readFile(join(root, "web-push.json"), "utf8")).subscriptions,
            ).toEqual([]),
          ),
        );
        expect(
          yield* Effect.exit(service.saveSubscription({ owner, subscription })),
        ).toHaveProperty("_tag", "Failure");
        yield* complete();
        yield* Effect.yieldNow;
        expect(send).toHaveBeenCalledOnce();
      }),
    );
  });
});
