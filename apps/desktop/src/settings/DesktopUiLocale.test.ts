import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeDesktopUiLocale, observeDesktopUiLocaleSettings } from "./DesktopUiLocale.ts";

describe("DesktopUiLocale", () => {
  it.live(
    "adopts a newly created settings namespace without a startup wait or unrelated-file refresh",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({
            prefix: "cafe-native-ui-language-",
          });
          const settingsDirectory = path.join(temporary, "new-state");
          const settingsPath = path.join(settingsDirectory, "client-settings.json");
          const observation = yield* observeDesktopUiLocaleSettings(settingsPath);
          let current: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, languagePreference: "en" };
          let reads = 0;
          const published: string[] = [];
          let resolveKorean: () => void = () => undefined;
          let resolveJapanese: () => void = () => undefined;
          const korean = new Promise<void>((resolve) => {
            resolveKorean = resolve;
          });
          const japanese = new Promise<void>((resolve) => {
            resolveJapanese = resolve;
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const locale = yield* makeDesktopUiLocale({
                ...observation,
                preferredSystemLanguages: Effect.succeed(["ja-JP"]),
                settings: Effect.sync(() => {
                  reads += 1;
                  return Option.some(current);
                }),
                publish: (value) => {
                  published.push(value);
                  if (value === "ko") resolveKorean();
                  if (value === "ja" && reads > 1) resolveJapanese();
                },
              });
              // Missing directory cannot block UI, nor may presentation create it.
              yield* locale.initialize;
              assert.equal(published.at(-1), "en");
              assert.isFalse(yield* fs.exists(settingsDirectory));
              current = { ...DEFAULT_CLIENT_SETTINGS, languagePreference: "ko" };
              yield* fs.makeDirectory(settingsDirectory);
              yield* Effect.promise(() => korean);
              assert.equal(published.at(-1), "ko");
              const admittedReads = reads;
              yield* fs.writeFileString(path.join(settingsDirectory, "unrelated.json"), "{}");
              yield* Effect.sleep("150 millis");
              assert.equal(reads, admittedReads);
              current = { ...DEFAULT_CLIENT_SETTINGS, languagePreference: "ja" };
              yield* fs.writeFileString(settingsPath, "{}");
              yield* Effect.promise(() => japanese);
              assert.equal(published.at(-1), "ja");
            }),
          );
          // Scope retirement closes the real watch before its fixture directory is
          // retired, including on hosts that deny deletion of held namespaces.
          yield* fs.remove(settingsDirectory, { recursive: true });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  for (const [preference, languages, expected] of [
    ["en", ["ja-JP"], "en"],
    ["system", ["ja-JP"], "ja"],
    ["system", ["ko-KR"], "ko"],
    ["system", ["fr-FR", "ja-JP"], "en"],
    ["ja", ["en-US"], "ja"],
  ] as const) {
    it.effect(`resolves ${preference} with primary ${languages[0]} to ${expected}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const published: string[] = [];
          const locale = yield* makeDesktopUiLocale({
            settings: Effect.succeed(
              Option.some({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: preference }),
            ),
            preferredSystemLanguages: Effect.succeed(languages),
            changes: Stream.never,
            publish: (value) => published.push(value),
          });
          yield* locale.initialize;
          assert.equal(published.at(-1), expected);
          assert.equal(
            yield* locale.systemLocale,
            languages[0]!.startsWith("ja") ? "ja" : languages[0]!.startsWith("ko") ? "ko" : "en",
          );
          const count = published.length;
          yield* locale.initialize;
          assert.equal(published.length, count);
        }),
      ),
    );
  }
  it.effect(
    "observes valid runtime replacements, preserves malformed choice, and retires its watcher",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let emit: (() => void) | undefined;
        let current: Option.Option<ClientSettings> = Option.some({
          ...DEFAULT_CLIENT_SETTINGS,
          languagePreference: "en",
        });
        const published: string[] = [];
        let retired = 0;
        let watchErrors = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const locale = yield* makeDesktopUiLocale({
              settings: Effect.sync(() => current),
              preferredSystemLanguages: Effect.succeed(["ja-JP"]),
              changes: Stream.callback<number>((queue) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    emit = () => Queue.offerUnsafe(queue, 1);
                  }).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
                  () =>
                    Effect.sync(() => {
                      retired += 1;
                      emit = undefined;
                    }),
                ),
              ),
              changesReady: Deferred.await(ready),
              publish: (value) => published.push(value),
              onWatchError: () => {
                watchErrors += 1;
              },
            });
            yield* locale.initialize;
            assert.equal(published.at(-1), "en");
            current = Option.some({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: "ko" });
            yield* Effect.sync(() => emit!());
            yield* Effect.yieldNow;
            yield* TestClock.adjust("101 millis");
            yield* Effect.yieldNow;
            assert.equal(watchErrors, 0);
            assert.equal(published.at(-1), "ko");
            current = Option.none();
            yield* Effect.sync(() => emit!());
            yield* Effect.yieldNow;
            yield* TestClock.adjust("101 millis");
            yield* Effect.yieldNow;
            assert.equal(published.at(-1), "ko");
            current = Option.some({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: "system" });
            yield* Effect.sync(() => emit!());
            yield* Effect.yieldNow;
            yield* TestClock.adjust("101 millis");
            yield* Effect.yieldNow;
            assert.equal(published.at(-1), "ja");
          }),
        );
        assert.equal(retired, 1);
        const count = published.length;
        assert.equal(emit, undefined);
        yield* TestClock.adjust("101 millis");
        assert.equal(published.length, count);
      }),
  );
  it.effect("uses System only for absent first-start settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const published: string[] = [];
        const locale = yield* makeDesktopUiLocale({
          settings: Effect.succeed(Option.none()),
          preferredSystemLanguages: Effect.succeed(["ko-KR"]),
          changes: Stream.empty,
          publish: (value) => published.push(value),
        });
        yield* locale.initialize;
        assert.deepEqual(published, ["ko"]);
      }),
    ),
  );
});
