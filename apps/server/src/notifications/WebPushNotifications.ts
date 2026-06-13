/**
 * WebPushNotifications - Web Push subscription store + turn-completion pusher.
 *
 * Browsers cannot keep a WebSocket alive while backgrounded, so clients that
 * enable notifications register a Web Push subscription instead. This service
 * persists those subscriptions (plus the server's VAPID keypair) in a JSON
 * file under the state dir and pushes a small payload whenever a provider
 * turn completes. The page's service worker (apps/web/public/sw.js) renders
 * the payload as a system notification.
 *
 * @module WebPushNotifications
 */
import { ThreadId } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import webpush from "web-push";
import { fromJsonStringPretty } from "@cafecode/shared/schemaJson";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

// Push services only require a syntactically valid contact; self-hosted
// deployments have no meaningful operator address.
const VAPID_SUBJECT = "mailto:notifications@cafe-code.invalid";
const PUSH_TTL_SECONDS = 3600;

export class WebPushNotificationsError extends Data.TaggedError("WebPushNotificationsError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

class WebPushDeliveryError extends Data.TaggedError("WebPushDeliveryError")<{
  readonly statusCode: number | null;
  readonly cause: unknown;
}> {}

const VapidKeyPair = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});

export const WebPushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
});
export type WebPushSubscriptionInput = typeof WebPushSubscriptionInput.Type;

const StoredWebPushSubscription = Schema.Struct({
  ...WebPushSubscriptionInput.fields,
  label: Schema.optional(Schema.String),
  createdAt: Schema.String,
});
type StoredWebPushSubscription = typeof StoredWebPushSubscription.Type;

const WebPushState = Schema.Struct({
  vapid: Schema.NullOr(VapidKeyPair).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  subscriptions: Schema.Array(StoredWebPushSubscription).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
type WebPushState = typeof WebPushState.Type;

const WebPushStateJson = fromJsonStringPretty(WebPushState);

const EMPTY_WEB_PUSH_STATE: WebPushState = { vapid: null, subscriptions: [] };

const WebPushPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  tag: Schema.String,
  threadPath: Schema.String,
});
const WebPushPayloadJson = Schema.fromJsonString(WebPushPayload);

export interface WebPushNotificationsShape {
  /** VAPID public key for PushManager.subscribe; generated on first use. */
  readonly getPublicKey: () => Effect.Effect<string, WebPushNotificationsError>;
  readonly saveSubscription: (input: {
    readonly subscription: WebPushSubscriptionInput;
    readonly label?: string | undefined;
  }) => Effect.Effect<void, WebPushNotificationsError>;
  readonly removeSubscription: (endpoint: string) => Effect.Effect<void, WebPushNotificationsError>;
  /** Subscribe to provider runtime events and push on turn completion. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WebPushNotifications extends Context.Service<
  WebPushNotifications,
  WebPushNotificationsShape
>()("cafecode/notifications/WebPushNotifications") {}

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "<invalid-endpoint>";
  }
}

function deliveryStatusCode(cause: unknown): number | null {
  if (typeof cause === "object" && cause !== null && "statusCode" in cause) {
    const statusCode = Number((cause as { statusCode: unknown }).statusCode);
    return Number.isFinite(statusCode) ? statusCode : null;
  }
  return null;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const providerService = yield* ProviderService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverEnvironment = yield* ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;

  const statePath = pathService.join(config.stateDir, "web-push.json");
  const stateMutex = yield* Semaphore.make(1);

  const readStateFromDisk = Effect.gen(function* () {
    const exists = yield* fs.exists(statePath);
    if (!exists) {
      return EMPTY_WEB_PUSH_STATE;
    }
    const contents = yield* fs.readFileString(statePath);
    return yield* Schema.decodeEffect(WebPushStateJson)(contents);
  }).pipe(
    Effect.mapError(
      (cause) => new WebPushNotificationsError({ detail: `Failed to read ${statePath}`, cause }),
    ),
  );

  const stateRef = yield* Ref.make<WebPushState>(
    yield* readStateFromDisk.pipe(
      Effect.catch((error) =>
        Effect.logWarning("web push state unreadable; starting empty", {
          detail: error.detail,
          cause: error.cause,
        }).pipe(Effect.as(EMPTY_WEB_PUSH_STATE)),
      ),
    ),
  );

  const persistState = (state: WebPushState) =>
    Schema.encodeEffect(WebPushStateJson)(state).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
        ),
      ),
      Effect.mapError(
        (cause) => new WebPushNotificationsError({ detail: `Failed to write ${statePath}`, cause }),
      ),
    );

  const updateState = (update: (state: WebPushState) => WebPushState) =>
    stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const next = update(yield* Ref.get(stateRef));
        yield* persistState(next);
        yield* Ref.set(stateRef, next);
        return next;
      }),
    );

  const getPublicKey: WebPushNotificationsShape["getPublicKey"] = Effect.fn("getPublicKey")(
    function* () {
      const current = yield* Ref.get(stateRef);
      if (current.vapid) {
        return current.vapid.publicKey;
      }
      const generated = yield* Effect.try({
        try: () => webpush.generateVAPIDKeys(),
        catch: (cause) =>
          new WebPushNotificationsError({ detail: "Failed to generate VAPID keys", cause }),
      });
      const next = yield* updateState((state) =>
        state.vapid ? state : { ...state, vapid: generated },
      );
      return (next.vapid ?? generated).publicKey;
    },
  );

  const saveSubscription: WebPushNotificationsShape["saveSubscription"] = Effect.fn(
    "saveSubscription",
  )(function* (input) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const entry: StoredWebPushSubscription = {
      ...input.subscription,
      ...(input.label !== undefined ? { label: input.label } : {}),
      createdAt,
    };
    yield* updateState((state) => ({
      ...state,
      subscriptions: [
        ...state.subscriptions.filter(
          (subscription) => subscription.endpoint !== input.subscription.endpoint,
        ),
        entry,
      ],
    }));
    yield* Effect.logInfo("web push subscription saved", {
      endpointHost: safeEndpointHost(input.subscription.endpoint),
      label: input.label,
    });
  });

  const removeSubscription: WebPushNotificationsShape["removeSubscription"] = Effect.fn(
    "removeSubscription",
  )(function* (endpoint) {
    yield* updateState((state) => ({
      ...state,
      subscriptions: state.subscriptions.filter(
        (subscription) => subscription.endpoint !== endpoint,
      ),
    }));
  });

  const pushToSubscription = (input: {
    readonly subscription: StoredWebPushSubscription;
    readonly vapid: { readonly publicKey: string; readonly privateKey: string };
    readonly payload: string;
  }) =>
    Effect.tryPromise({
      try: () =>
        webpush.sendNotification(
          { endpoint: input.subscription.endpoint, keys: input.subscription.keys },
          input.payload,
          {
            TTL: PUSH_TTL_SECONDS,
            vapidDetails: {
              subject: VAPID_SUBJECT,
              publicKey: input.vapid.publicKey,
              privateKey: input.vapid.privateKey,
            },
          },
        ),
      catch: (cause) =>
        new WebPushDeliveryError({ statusCode: deliveryStatusCode(cause), cause }),
    });

  const notifyTurnCompleted = Effect.fn("notifyTurnCompleted")(function* (threadId: ThreadId) {
    const state = yield* Ref.get(stateRef);
    const vapid = state.vapid;
    if (vapid === null || state.subscriptions.length === 0) {
      return;
    }
    const shell = yield* snapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.catch(() => Effect.succeedNone));
    if (Option.isNone(shell)) {
      return;
    }
    const descriptor = yield* serverEnvironment.getDescriptor;
    const payload = yield* Schema.encodeEffect(WebPushPayloadJson)({
      title: shell.value.title,
      body: "Finished running",
      tag: `cafe-code-thread-${threadId}`,
      threadPath: `/${descriptor.environmentId}/${threadId}`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WebPushNotificationsError({ detail: "Failed to encode push payload", cause }),
      ),
    );

    const staleEndpoints: string[] = [];
    yield* Effect.forEach(
      state.subscriptions,
      (subscription) =>
        pushToSubscription({ subscription, vapid, payload }).pipe(
          Effect.catch((error) => {
            if (error.statusCode === 404 || error.statusCode === 410) {
              // The push service says this subscription no longer exists
              // (browser data cleared, permission revoked) — drop it.
              staleEndpoints.push(subscription.endpoint);
              return Effect.void;
            }
            return Effect.logWarning("web push delivery failed", {
              endpointHost: safeEndpointHost(subscription.endpoint),
              statusCode: error.statusCode,
            });
          }),
        ),
      { concurrency: 4, discard: true },
    );

    if (staleEndpoints.length > 0) {
      yield* updateState((state) => ({
        ...state,
        subscriptions: state.subscriptions.filter(
          (subscription) => !staleEndpoints.includes(subscription.endpoint),
        ),
      })).pipe(Effect.catch(() => Effect.void));
    }
  });

  const start: WebPushNotificationsShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.completed") {
          return Effect.void;
        }
        return notifyTurnCompleted(ThreadId.make(String(event.threadId))).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.logWarning("web push reactor failed to process turn completion", {
              threadId: event.threadId,
              cause: Cause.pretty(cause),
            });
          }),
        );
      }),
    );
  });

  return {
    getPublicKey,
    saveSubscription,
    removeSubscription,
    start,
  } satisfies WebPushNotificationsShape;
});

export const WebPushNotificationsLive = Layer.effect(WebPushNotifications, make);

/** Inert implementation for tests and harnesses that don't exercise push. */
export const WebPushNotificationsTest = Layer.succeed(WebPushNotifications, {
  getPublicKey: () => Effect.succeed("test-vapid-public-key"),
  saveSubscription: () => Effect.void,
  removeSubscription: () => Effect.void,
  start: () => Effect.void,
});
