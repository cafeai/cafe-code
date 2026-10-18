import { withSessionAdmission } from "../auth/sessionAdmission.ts";
import { uiText } from "@cafecode/shared/i18n";

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
import { AuthSessionId } from "@cafecode/contracts/auth";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import {
  PrivatePushStatePathError,
  readPrivatePushState,
  writePrivatePushState,
} from "./privateState.ts";
import { ThreadId, TurnId } from "@cafecode/contracts";
import { ScheduledFollowups } from "../scheduledFollowups/service.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

// Push services only require a syntactically valid contact; self-hosted
// deployments have no meaningful operator address.
const VAPID_SUBJECT = "mailto:notifications@cafe-code.invalid";
const PUSH_TTL_SECONDS = 3600;

interface WebPushNotificationsErrorFields {
  readonly detail: string;
  readonly cause?: unknown;
  readonly initializationStage?: "read" | "decode" | "reconcile";
}
export class WebPushNotificationsError extends Data.TaggedError(
  "WebPushNotificationsError",
)<WebPushNotificationsErrorFields> {
  constructor(fields: WebPushNotificationsErrorFields) {
    super(fields);
    // Effect's error renderer reads Error.message, not the domain detail field.
    // Keep the fixed safe explanation visible instead of a blank tagged error.
    this.message = fields.detail;
  }
}

const VapidKeyPair = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});

export const WebPushSubscriptionInput = Schema.Struct({
  uiLocale: Schema.optionalKey(Schema.Literals(["en", "ja", "ko"])),
  endpoint: Schema.String.check(Schema.isMaxLength(4096)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMaxLength(1024)),
    auth: Schema.String.check(Schema.isMaxLength(1024)),
  }),
});
export type WebPushSubscriptionInput = typeof WebPushSubscriptionInput.Type;

const PushOwner = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  role: Schema.Literals(["owner", "client"]),
  expiresAt: Schema.String,
});
const StoredWebPushSubscription = Schema.Struct({
  ...WebPushSubscriptionInput.fields,
  owner: Schema.optionalKey(PushOwner),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  createdAt: Schema.String,
});
type StoredWebPushSubscription = typeof StoredWebPushSubscription.Type;

/** Locale is data owned by an already admitted endpoint and its key pair.
 * This pure range-preserving update cannot add/rebind subscriptions, including
 * when a delayed browser update arrives after an explicit unsubscribe. */
export function withWebPushSubscriptionLocale<T extends WebPushSubscriptionInput>(
  subscriptions: readonly T[],
  input: WebPushSubscriptionInput,
): readonly T[] {
  if (input.uiLocale !== "en" && input.uiLocale !== "ja" && input.uiLocale !== "ko")
    return subscriptions;
  return subscriptions.map((subscription) =>
    subscription.endpoint === input.endpoint &&
    subscription.keys.p256dh === input.keys.p256dh &&
    subscription.keys.auth === input.keys.auth
      ? { ...subscription, uiLocale: input.uiLocale }
      : subscription,
  );
}

export function webPushCompletionBody(locale: WebPushSubscriptionInput["uiLocale"]): string {
  return uiText("Finished running", undefined, undefined, locale ?? "en");
}

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

// Hoisted compiled codecs — building these per call rebuilds the codec every time.
const decodeWebPushState = Schema.decodeEffect(WebPushStateJson);
const encodeWebPushState = Schema.encodeEffect(WebPushStateJson);
const encodeWebPushPayload = Schema.encodeEffect(WebPushPayloadJson);

export interface WebPushNotificationsShape {
  /** VAPID public key for PushManager.subscribe; generated on first use. */
  readonly getPublicKey: () => Effect.Effect<string, WebPushNotificationsError>;
  readonly saveSubscription: (input: {
    readonly owner: AuthenticatedSession;
    readonly subscription: WebPushSubscriptionInput;
    readonly label?: string | undefined;
  }) => Effect.Effect<void, WebPushNotificationsError>;
  readonly removeSubscription: (
    endpoint: string,
    owner: AuthenticatedSession,
  ) => Effect.Effect<void, WebPushNotificationsError>;
  /** Presentation-only update of an existing exact endpoint/key owner. */
  readonly updateSubscriptionLocale: (
    subscription: WebPushSubscriptionInput,
    owner: AuthenticatedSession,
  ) => Effect.Effect<void, WebPushNotificationsError>;
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

const initializeWebPushNotifications = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const providerService = yield* ProviderService;
  const sessions = yield* SessionCredentialService;
  const scheduledFollowups = yield* ScheduledFollowups;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverEnvironment = yield* ServerEnvironment;
  const pathService = yield* Path.Path;

  const statePath = pathService.join(config.stateDir, "web-push.json");
  const stateMutex = yield* Semaphore.make(1);

  let persisted: string | undefined;
  const readStateFromDisk = Effect.tryPromise({
    try: () => readPrivatePushState(statePath),
    catch: (error) =>
      new WebPushNotificationsError({
        detail:
          error instanceof PrivatePushStatePathError
            ? error.message
            : "Failed to read private push state",
        initializationStage: "read",
      }),
  }).pipe(
    Effect.flatMap((contents) => {
      persisted = contents;
      return contents === undefined
        ? Effect.succeed(EMPTY_WEB_PUSH_STATE)
        : decodeWebPushState(contents).pipe(
            Effect.mapError(
              () =>
                new WebPushNotificationsError({
                  detail: "Failed to decode private push state",
                  initializationStage: "decode",
                }),
            ),
          );
    }),
  );
  // A failed migration must preserve evidence and stop delivery, not replace it
  // with an apparently new identity. The outer initializer isolates this
  // optional service's typed failures without admitting unsafe state.
  const initial = yield* readStateFromDisk;
  const stateRef = yield* Ref.make<WebPushState>(initial);
  const persistState = (state: WebPushState) =>
    encodeWebPushState(state).pipe(
      Effect.flatMap((contents) =>
        Effect.tryPromise({
          try: async () => {
            const serialized = `${contents}\n`;
            await writePrivatePushState(statePath, serialized, persisted);
            persisted = serialized;
          },
          catch: () =>
            new WebPushNotificationsError({ detail: "Failed to save private push state" }),
        }),
      ),
      Effect.mapError(
        () => new WebPushNotificationsError({ detail: "Failed to save private push state" }),
      ),
    );

  const identity = (subscription: StoredWebPushSubscription) => {
    const owner = subscription.owner;
    if (!owner) return undefined;
    const expiresAt = DateTime.make(owner.expiresAt);
    return Option.isSome(expiresAt) ? { ...owner, expiresAt: expiresAt.value } : undefined;
  };
  const isActive = (subscription: StoredWebPushSubscription) => {
    const owner = identity(subscription);
    return owner
      ? sessions.validateActiveSession(owner).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )
      : Effect.succeed(false);
  };

  const commitState = (state: WebPushState) =>
    Effect.uninterruptible(persistState(state).pipe(Effect.andThen(Ref.set(stateRef, state))));

  const updateState = (update: (state: WebPushState) => WebPushState) =>
    stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const next = update(yield* Ref.get(stateRef));
        yield* commitState(next);
        return next;
      }),
    );

  const reconcileOwners = stateMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      const subscriptions = yield* Effect.filter(current.subscriptions, isActive);
      const next = { ...current, subscriptions };
      yield* commitState(next);
    }),
  );
  yield* reconcileOwners;

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
    yield* sessions
      .validateActiveSession(input.owner)
      .pipe(
        Effect.mapError(
          () => new WebPushNotificationsError({ detail: "Push session is no longer active" }),
        ),
      );
    if (!input.owner.expiresAt)
      return yield* new WebPushNotificationsError({ detail: "Push session expiry required" });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const entry: StoredWebPushSubscription = {
      ...input.subscription,
      owner: {
        sessionId: input.owner.sessionId,
        subject: input.owner.subject,
        method: input.owner.method,
        role: input.owner.role,
        expiresAt: DateTime.formatIso(input.owner.expiresAt),
      },
      ...(input.label !== undefined ? { label: input.label } : {}),
      createdAt,
    };
    yield* stateMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* sessions
          .validateActiveSession(input.owner)
          .pipe(
            Effect.mapError(
              () => new WebPushNotificationsError({ detail: "Push session is no longer active" }),
            ),
          );
        const state = yield* Ref.get(stateRef);
        const existing = state.subscriptions.find(
          (subscription) => subscription.endpoint === entry.endpoint,
        );
        if (
          (existing && existing.owner?.sessionId !== input.owner.sessionId) ||
          (!existing && state.subscriptions.length >= 512)
        )
          return yield* new WebPushNotificationsError({
            detail: "Push subscription cannot be assigned",
          });
        const next = {
          ...state,
          subscriptions: [
            ...state.subscriptions.filter(
              (subscription) => subscription.endpoint !== entry.endpoint,
            ),
            entry,
          ],
        };
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* persistState(next);
            yield* withSessionAdmission(
              sessions.validateActiveSession(input.owner).pipe(
                Effect.andThen(Ref.set(stateRef, next)),
                Effect.catch(() =>
                  persistState(state).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new WebPushNotificationsError({
                          detail: "Push session is no longer active",
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
        );
      }),
    );
    yield* Effect.logInfo("web push subscription saved", {
      endpointHost: safeEndpointHost(input.subscription.endpoint),
    });
  });

  const removeSubscription: WebPushNotificationsShape["removeSubscription"] = Effect.fn(
    "removeSubscription",
  )(function* (endpoint, owner) {
    yield* updateState((state) => ({
      ...state,
      subscriptions: state.subscriptions.filter(
        (subscription) =>
          subscription.endpoint !== endpoint || subscription.owner?.sessionId !== owner.sessionId,
      ),
    }));
  });

  const updateSubscriptionLocale: WebPushNotificationsShape["updateSubscriptionLocale"] = (
    input,
    owner,
  ) =>
    updateState((state) => ({
      ...state,
      subscriptions: state.subscriptions.map((subscription) =>
        subscription.owner?.sessionId === owner.sessionId
          ? withWebPushSubscriptionLocale([subscription], input)[0]!
          : subscription,
      ),
    }));

  const admitPush = (
    subscription: StoredWebPushSubscription,
    vapid: NonNullable<WebPushState["vapid"]>,
    payload: string,
  ) =>
    stateMutex.withPermits(1)(
      withSessionAdmission(
        Effect.gen(function* () {
          const current = yield* Ref.get(stateRef);
          if (!current.subscriptions.includes(subscription) || !(yield* isActive(subscription)))
            return null;
          return yield* Effect.sync(() => {
            try {
              // Observe rejection immediately while the lock is still held. The
              // returned thunk awaits the already initiated transport after release.
              const pending = webpush
                .sendNotification(
                  { endpoint: subscription.endpoint, keys: subscription.keys },
                  payload,
                  {
                    TTL: PUSH_TTL_SECONDS,
                    timeout: 10_000,
                    vapidDetails: {
                      subject: VAPID_SUBJECT,
                      publicKey: vapid.publicKey,
                      privateKey: vapid.privateKey,
                    },
                  },
                )
                .then(
                  () => ({ status: null as number | null }),
                  (cause) => ({ status: deliveryStatusCode(cause) ?? 0 }),
                );
              return () => pending;
            } catch (cause) {
              return () => Promise.resolve({ status: deliveryStatusCode(cause) ?? 0 });
            }
          });
        }),
      ),
    );

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
    const staleSubscriptions = new Set<StoredWebPushSubscription>();
    yield* Effect.forEach(
      state.subscriptions,
      (subscription) =>
        Effect.gen(function* () {
          // Every recipient selects an isolated bundled translator; changing
          // one browser's language never mutates shared server presentation.
          const payload = yield* encodeWebPushPayload({
            title: shell.value.title,
            body: webPushCompletionBody(subscription.uiLocale),
            tag: `cafe-code-thread-${threadId}`,
            threadPath: `/${descriptor.environmentId}/${threadId}`,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new WebPushNotificationsError({ detail: "Failed to encode push payload", cause }),
            ),
          );
          // Final local admission immediately precedes transport initiation.
          // Accepted remote pushes cannot be recalled after this boundary.
          const delivery = yield* admitPush(subscription, vapid, payload);
          if (delivery === null) {
            staleSubscriptions.add(subscription);
            return;
          }
          const result = yield* Effect.promise(delivery);
          if (result.status === 404 || result.status === 410) staleSubscriptions.add(subscription);
          else if (result.status !== null)
            yield* Effect.logWarning("web push delivery failed", { statusCode: result.status });
        }),
      { concurrency: 4, discard: true },
    );

    if (staleSubscriptions.size > 0) {
      yield* updateState((state) => ({
        ...state,
        subscriptions: state.subscriptions.filter(
          (subscription) => !staleSubscriptions.has(subscription),
        ),
      })).pipe(Effect.catch(() => Effect.void));
    }
  });

  const start: WebPushNotificationsShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(sessions.streamChanges, () =>
        reconcileOwners.pipe(
          Effect.catch(() => Effect.logWarning("Push owner reconciliation failed")),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("1 minute").pipe(
          Effect.andThen(reconcileOwners),
          Effect.catch(() => Effect.logWarning("Push expiry reconciliation failed")),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.completed") {
          return Effect.void;
        }
        return scheduledFollowups
          .notification(
            ThreadId.make(String(event.threadId)),
            event.turnId ? TurnId.make(String(event.turnId)) : null,
          )
          .pipe(
            Effect.catch(() => Effect.succeed({ notify: true })),
            Effect.flatMap(({ notify }) =>
              notify ? notifyTurnCompleted(ThreadId.make(String(event.threadId))) : Effect.void,
            ),
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
    updateSubscriptionLocale,
    start,
  } satisfies WebPushNotificationsShape;
});

/** Push storage is optional to chat startup, but its security checks are not.
 * Retain the failed namespace/state and never generate a replacement identity,
 * start delivery consumers or retry writes after initialization is refused.
 * Only this service's typed errors are isolated: interruption and defects keep
 * their ordinary failure semantics instead of being disguised as availability.
 */
export const makeWebPushNotifications = initializeWebPushNotifications.pipe(
  Effect.catchTag("WebPushNotificationsError", (error) => {
    const phase = error.initializationStage ?? "reconcile";
    // Fixed phase metadata is sufficient for diagnosis. Never log the private
    // input, filesystem path, VAPID keys, endpoints or raw decoder/I/O cause.
    const unavailable = () =>
      Effect.fail(
        new WebPushNotificationsError({
          detail: "Web Push is unavailable until its private state can be safely loaded.",
        }),
      );
    return Effect.logWarning("Web Push disabled; Cafe startup continues", {
      phase,
      detail: error.detail,
    }).pipe(
      Effect.as({
        getPublicKey: unavailable,
        saveSubscription: unavailable,
        removeSubscription: unavailable,
        updateSubscriptionLocale: unavailable,
        start: () => Effect.void,
      } satisfies WebPushNotificationsShape),
    );
  }),
);

export const WebPushNotificationsLive = Layer.effect(
  WebPushNotifications,
  makeWebPushNotifications,
);

/** Inert implementation for tests and harnesses that don't exercise push. */
export const WebPushNotificationsTest = Layer.succeed(WebPushNotifications, {
  getPublicKey: () => Effect.succeed("test-vapid-public-key"),
  saveSubscription: () => Effect.void,
  removeSubscription: () => Effect.void,
  updateSubscriptionLocale: () => Effect.void,
  start: () => Effect.void,
});
