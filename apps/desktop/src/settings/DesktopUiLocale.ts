import { resolveUiLocale, setUiLocale, type UiLocale } from "@cafecode/shared/i18n";
import type { ClientSettings } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { watch } from "node:fs";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

export interface DesktopUiLocaleShape {
  readonly initialize: Effect.Effect<void>;
  readonly systemLocale: Effect.Effect<UiLocale>;
}

export class DesktopUiLocale extends Context.Service<DesktopUiLocale, DesktopUiLocaleShape>()(
  "cafecode/desktop/UiLocale",
) {}

/** Main owns presentation only. Preferences remain in the existing backend-
 * authoritative document; this service never writes it or derives provider or
 * process authority from its contents. Exact namespace observation is scoped. */
export const makeDesktopUiLocale = Effect.fn("desktop.uiLocale.make")(function* (input: {
  readonly settings: Effect.Effect<Option.Option<ClientSettings>>;
  readonly preferredSystemLanguages: Effect.Effect<readonly string[]>;
  readonly changes: Stream.Stream<unknown, unknown>;
  readonly changesReady?: Effect.Effect<void>;
  readonly publish?: (locale: UiLocale) => void;
  readonly onWatchError?: () => void;
}) {
  const scope = yield* Scope.Scope;
  let initialized = false;
  let systemLocale: UiLocale = "en";
  const publish = input.publish ?? setUiLocale;
  const refresh = Effect.gen(function* () {
    const settings = yield* input.settings;
    // A malformed replacement cannot flip an established explicit choice to
    // System. First startup alone uses the safe system fallback.
    if (Option.isSome(settings)) {
      publish(resolveUiLocale(settings.value.languagePreference, [systemLocale]));
    }
  });
  const initialize = Effect.gen(function* () {
    if (initialized) return;
    initialized = true;
    systemLocale = resolveUiLocale("system", yield* input.preferredSystemLanguages);
    publish(systemLocale);
    // Start observation before reading the atomically replaced document.
    yield* input.changes.pipe(
      Stream.debounce(Duration.millis(100)),
      Stream.runForEach(() => refresh),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => input.onWatchError?.()),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    yield* input.changesReady ?? Effect.void;
    yield* refresh;
  });
  return DesktopUiLocale.of({ initialize, systemLocale: Effect.sync(() => systemLocale) });
});

export const observeDesktopUiLocaleSettings = Effect.fn("desktop.uiLocale.observeSettings")(
  function* (clientSettingsPath: string) {
    const path = yield* Path.Path;
    const settingsDir = path.dirname(clientSettingsPath);
    const settingsFile = path.basename(clientSettingsPath);
    const settingsPath = path.resolve(clientSettingsPath);
    const ready = yield* Deferred.make<void>();
    // Native registration is synchronous; unlike FileSystem.watch's async
    // pre-registration stat this handshake binds observation before the
    // initial read. Failure still releases startup, retaining its safe default.
    const changes = Stream.callback<number, "unavailable">(
      (queue) =>
        Effect.acquireRelease(
          Effect.try({
            try: () => {
              const watcher = watch(settingsDir, { persistent: false }, (_event, filename) => {
                if (!filename) return;
                const observed = filename.toString();
                if (
                  observed === settingsFile ||
                  observed === clientSettingsPath ||
                  path.resolve(settingsDir, observed) === settingsPath
                )
                  Queue.offerUnsafe(queue, 1);
              });
              watcher.on("error", () => Queue.failCauseUnsafe(queue, Cause.fail("unavailable")));
              watcher.on("close", () => Queue.failCauseUnsafe(queue, Cause.fail("unavailable")));
              return watcher;
            },
            catch: () => "unavailable" as const,
          }),
          (watcher) => Effect.sync(() => watcher.close()),
        ).pipe(
          Effect.tap(() =>
            Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Effect.sync(() => Queue.offerUnsafe(queue, 1))),
            ),
          ),
          Effect.catch(() =>
            Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Queue.fail(queue, "unavailable")),
            ),
          ),
        ),
      { bufferSize: 1, strategy: "sliding" },
    ).pipe(
      // Fresh installations may not have the backend-created state directory
      // yet. Retry read-only registration without creating it or blocking UI.
      // A successful re-admission emits one reconciliation event, closing any
      // changes that happened while no observer was available.
      Stream.retry(Schedule.spaced("2 seconds")),
    );
    return { changes, changesReady: Deferred.await(ready) };
  },
);

export const layer = Layer.effect(
  DesktopUiLocale,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    const app = yield* ElectronApp.ElectronApp;
    const observation = yield* observeDesktopUiLocaleSettings(environment.clientSettingsPath);
    return yield* makeDesktopUiLocale({
      settings: settings.get,
      preferredSystemLanguages: app.preferredSystemLanguages ?? Effect.succeed([]),
      ...observation,
    });
  }),
);
