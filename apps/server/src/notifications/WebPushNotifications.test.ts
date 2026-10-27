import { withSessionAdmission } from "../auth/sessionAdmission.ts";
import assert from "node:assert/strict";
// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { describe, expect, it, vi } from "vitest";
import { AuthSessionId } from "@cafecode/contracts/auth";
import { EventId, ThreadId } from "@cafecode/contracts";
import * as privateState from "./privateState.ts";
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
import * as Schema from "effect/Schema";

const decodeJsonText = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      subscriptions: Schema.Array(
        Schema.Struct({
          owner: Schema.Struct({ sessionId: Schema.String }),
          uiLocale: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);
const encodeJsonText = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodePushPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String, threadPath: Schema.String })),
);

const send = vi.hoisted(() =>
  vi.fn(async (_subscription: unknown, _payload: string, _options: unknown) => ({
    statusCode: 201,
  })),
);
const generateVAPIDKeys = vi.hoisted(() =>
  vi.fn(() => ({ publicKey: "public", privateKey: "private" })),
);
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys,
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

async function fixture<E>(
  task: (input: {
    root: string;
    service: WebPushNotificationsShape;
    restart: (
      stateDir?: string,
    ) => Effect.Effect<WebPushNotificationsShape, WebPushNotificationsError>;
    complete: () => Effect.Effect<void>;
    askForInput: (eventId?: string) => Effect.Effect<void>;
    revoke: () => Effect.Effect<void>;
    reactorStarts: () => { sessions: number; provider: number };
  }) => Effect.Effect<void, E, Scope.Scope>,
) {
  send.mockClear();
  generateVAPIDKeys.mockClear();
  const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-push-owner-")));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* PubSub.unbounded<SessionCredentialChange>();
          const completions = yield* PubSub.unbounded<{
            type: "turn.completed" | "user-input.requested";
            threadId: ThreadId;
            eventId?: EventId;
          }>();
          const active = new Set([owner.sessionId]);
          const reactorStarts = { sessions: 0, provider: 0 };
          const serviceEffect = (stateDir = root) =>
            makeWebPushNotifications.pipe(
              Effect.provideService(ServerConfig, { stateDir } as never),
              Effect.provideService(SessionCredentialService, {
                validateActiveSession: (identity: typeof owner) =>
                  Effect.suspend(() =>
                    active.has(identity.sessionId)
                      ? Effect.void
                      : Effect.fail(new SessionCredentialError({ message: "Revoked" })),
                  ),
                streamChanges: Stream.unwrap(
                  Effect.sync(() => {
                    reactorStarts.sessions += 1;
                    return Stream.fromPubSub(changes);
                  }),
                ),
              } as never),
              Effect.provideService(ProviderService, {
                streamEvents: Stream.unwrap(
                  Effect.sync(() => {
                    reactorStarts.provider += 1;
                    return Stream.fromPubSub(completions);
                  }),
                ),
              } as never),
              Effect.provideService(ScheduledFollowups, {
                notification: () => Effect.succeed({ notify: true }),
              } as never),
              Effect.provideService(ProjectionSnapshotQuery, {
                getThreadShellById: () =>
                  Effect.succeed(Option.some({ title: "Synthetic thread" })),
              } as never),
              Effect.provideService(ServerEnvironment, {
                getDescriptor: Effect.succeed({ environmentId: "fixture" }),
              } as never),
              Effect.provide(NodeServices.layer),
            );
          const service = yield* serviceEffect();
          yield* task({
            root,
            service,
            restart: serviceEffect,
            reactorStarts: () => ({ ...reactorStarts }),
            complete: () =>
              PubSub.publish(completions, {
                type: "turn.completed" as const,
                threadId: ThreadId.make("fixture"),
              }).pipe(Effect.asVoid),
            askForInput: (eventId = "input-request-one") =>
              PubSub.publish(completions, {
                type: "user-input.requested",
                threadId: ThreadId.make("fixture"),
                eventId: EventId.make(eventId),
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

/** Unavailable push storage never authorizes a fresh identity or delivery. These
 * checks exercise every exposed operation, including repeat calls on the same
 * disabled instance, rather than accepting a success-valued dummy service. */
const assertUnavailable = (
  service: WebPushNotificationsShape,
  complete: () => Effect.Effect<void>,
  revoke: () => Effect.Effect<void>,
  reactorStarts: () => { sessions: number; provider: number },
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.spyOn(privateState, "readPrivatePushState")),
    (reader) =>
      Effect.gen(function* () {
        const operations: ReadonlyArray<Effect.Effect<unknown, WebPushNotificationsError>> = [
          service.getPublicKey(),
          service.saveSubscription({ owner, subscription }),
          service.removeSubscription(subscription.endpoint, owner),
          service.updateSubscriptionLocale({ ...subscription, uiLocale: "ja" }, owner),
        ];
        for (const operation of operations) {
          expect(
            yield* operation.pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => assert.fail("Expected the unavailable operation to fail"),
              }),
            ),
          ).toMatchObject({
            _tag: "WebPushNotificationsError",
            detail: "Web Push is unavailable until its private state can be safely loaded.",
            message: "Web Push is unavailable until its private state can be safely loaded.",
          });
        }
        yield* service.start();
        yield* complete();
        yield* revoke();
        yield* Effect.yieldNow;
        expect(reactorStarts()).toEqual({ sessions: 0, provider: 0 });
        expect(send).not.toHaveBeenCalled();
        expect(generateVAPIDKeys).not.toHaveBeenCalled();
        expect(yield* Effect.flip(service.getPublicKey())).toHaveProperty(
          "detail",
          "Web Push is unavailable until its private state can be safely loaded.",
        );
        // A later request cannot silently re-admit changed storage through the
        // failed instance; recovery requires a separately initialized service.
        expect(reader).not.toHaveBeenCalled();
      }),
    (reader) => Effect.sync(() => reader.mockRestore()),
  );

describe("session-owned Web Push", () => {
  it("persists independent input opt-in and suppresses replay without changing legacy completion delivery", async () => {
    await fixture(({ service, restart, complete, askForInput }) =>
      Effect.gen(function* () {
        yield* service.getPublicKey();
        yield* service.saveSubscription({ owner, subscription });
        const inputSubscription = {
          ...subscription,
          endpoint: "https://push.example/input-only",
          notifyOnCompletion: false,
          notifyOnUserInput: true,
          uiLocale: "ja" as const,
        };
        yield* service.saveSubscription({ owner, subscription: inputSubscription });
        const restarted = yield* restart();
        yield* restarted.start();
        yield* Effect.yieldNow;
        yield* askForInput();
        yield* Effect.promise(() => vi.waitFor(() => expect(send).toHaveBeenCalledOnce()));
        expect(send.mock.calls[0]?.[0]).toEqual({
          endpoint: inputSubscription.endpoint,
          keys: subscription.keys,
        });
        expect(decodePushPayload(send.mock.calls[0]?.[1])).toMatchObject({
          body: "入力を待っています",
          threadPath: "/fixture/fixture",
        });
        // Completion is a serial-consumer barrier after the duplicate input:
        // by its observed delivery, the duplicate has been fully processed.
        yield* askForInput();
        yield* complete();
        yield* Effect.promise(() => vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2)));
        expect(send.mock.calls[1]?.[0]).toEqual(subscription);
        expect(decodePushPayload(send.mock.calls[1]?.[1]).body).toBe("Finished running");
        yield* askForInput("input-request-two");
        yield* Effect.promise(() => vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3)));
        expect(send.mock.calls[2]?.[0]).toEqual({
          endpoint: inputSubscription.endpoint,
          keys: subscription.keys,
        });
      }),
    );
  });

  it("refuses oversized UTF-8 state before replacing the last restartable identity", async () => {
    await fixture(({ root, service, restart }) =>
      Effect.gen(function* () {
        const publicKey = yield* service.getPublicKey();
        const state = join(root, "web-push.json");
        const previous = yield* Effect.promise(() => readFile(state, "utf8"));
        const oversized = encodeJsonText({
          vapid: { publicKey, privateKey: "é".repeat(512 * 1024) },
          subscriptions: [],
        });
        expect(oversized.length).toBeLessThan(1024 * 1024);
        yield* Effect.promise(() =>
          expect(privateState.writePrivatePushState(state, oversized, previous)).rejects.toThrow(
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
    await fixture(({ root, restart, complete, revoke, reactorStarts }) =>
      Effect.gen(function* () {
        const state = join(root, "web-push.json");
        yield* Effect.promise(() => writeFile(state, "malformed private state"));
        const unavailable = yield* restart();
        yield* assertUnavailable(unavailable, complete, revoke, reactorStarts);
        expect(yield* Effect.promise(() => readFile(state, "utf8"))).toBe(
          "malformed private state",
        );
      }),
    );
  });

  it("preserves oversized stored state while keeping push unavailable", async () => {
    await fixture(({ root, restart, complete, revoke, reactorStarts }) =>
      Effect.gen(function* () {
        const state = join(root, "web-push.json");
        const oversized = encodeJsonText({
          vapid: { publicKey: "old-public", privateKey: "é".repeat(512 * 1024) },
          subscriptions: [],
        });
        // The byte limit must still reject valid JSON with fewer UTF-16 code
        // units than bytes; unavailable startup cannot rewrite it as empty.
        expect(oversized.length).toBeLessThan(1024 * 1024);
        yield* Effect.promise(() => writeFile(state, oversized));
        const unavailable = yield* restart();
        yield* assertUnavailable(unavailable, complete, revoke, reactorStarts);
        expect(yield* Effect.promise(() => readFile(state, "utf8"))).toBe(oversized);
      }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses unsafe ancestor permissions without creating push state or repairing the ancestor",
    async () => {
      await fixture(({ root, restart, complete, revoke, reactorStarts }) =>
        Effect.gen(function* () {
          const stateDir = join(root, "state");
          const state = join(stateDir, "web-push.json");
          const previous = yield* Effect.promise(() =>
            readFile(join(root, "web-push.json"), "utf8"),
          );
          yield* Effect.promise(() => mkdir(stateDir, { mode: 0o700 }));
          // Only this fixture-owned temporary ancestor receives the refused
          // legacy mode. No workstation home or existing application state is
          // inspected or changed to manufacture the admission failure.
          yield* Effect.promise(() => chmod(root, 0o770));
          const messages: unknown[] = [];
          const logCapture = Logger.make<unknown, void>(({ message }) => {
            if (Array.isArray(message)) messages.push(...message);
            else messages.push(message);
          });
          // Capture only this rejected initialization, using the real private
          // reader. Diagnostics explain the fixed admission rule without
          // revealing the rejected namespace or any persisted secret material.
          const unavailable = yield* restart(stateDir).pipe(
            Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })),
          );
          expect(messages).toEqual([
            "Web Push disabled; Cafe startup continues",
            {
              phase: "read",
              detail:
                "Web Push private-state directories must be owner-controlled, unlinked and not group/other-writable.",
            },
          ]);
          const diagnostic = encodeJsonText(messages);
          for (const privateValue of [
            root,
            state,
            previous,
            subscription.keys.auth,
            subscription.keys.p256dh,
          ]) {
            expect(diagnostic).not.toContain(privateValue);
          }
          yield* assertUnavailable(unavailable, complete, revoke, reactorStarts);
          expect((yield* Effect.promise(() => stat(root))).mode & 0o777).toBe(0o770);
          yield* Effect.promise(() =>
            expect(readFile(state, "utf8")).rejects.toMatchObject({ code: "ENOENT" }),
          );
          expect(yield* Effect.promise(() => readFile(join(root, "web-push.json"), "utf8"))).toBe(
            previous,
          );
        }),
      );
    },
  );

  it("preserves the loaded identity when initial owner reconciliation cannot be saved", async () => {
    await fixture(({ root, restart, complete, revoke, reactorStarts }) =>
      Effect.gen(function* () {
        const state = join(root, "web-push.json");
        const previous = encodeJsonText({
          vapid: { publicKey: "old-public", privateKey: "old-private" },
          subscriptions: [{ ...subscription, createdAt: "2026-01-01" }],
        });
        yield* Effect.promise(() => writeFile(state, previous));
        // Fail only the exact next initialization write, after the real bounded
        // private reader has admitted and decoded this fixture's existing file.
        const writer = vi
          .spyOn(privateState, "writePrivatePushState")
          .mockRejectedValueOnce(new Error("Synthetic private push write failure"));
        try {
          const unavailable = yield* restart();
          expect(writer).toHaveBeenCalledExactlyOnceWith(state, expect.any(String), previous);
          yield* assertUnavailable(unavailable, complete, revoke, reactorStarts);
          expect(writer).toHaveBeenCalledOnce();
          expect(yield* Effect.promise(() => readFile(state, "utf8"))).toBe(previous);
        } finally {
          writer.mockRestore();
        }
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
        const stored = decodeJsonText(
          yield* Effect.promise(() => readFile(join(root, "web-push.json"), "utf8")),
        );
        expect(stored.subscriptions).toHaveLength(1);
        assert.ok(stored.subscriptions[0]);
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
        const stored = decodeJsonText(yield* Effect.promise(() => readFile(state, "utf8")));
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
