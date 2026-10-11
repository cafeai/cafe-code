import { createHash } from "node:crypto";
import type * as Electron from "electron";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

const { getAllWindowsMock, getFocusedWindowMock } = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  },
}));

import { makeDesktopStartupWindow } from "./DesktopStartupWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  createDesktopStartupDocument,
  DESKTOP_STARTUP_STYLE,
} from "@cafecode/shared/desktopStartupDocument";

function fakeWindow() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const webListeners = new Map<string, (...args: any[]) => void>();
  let destroyed = false;
  const target = {
    on: vi.fn((name: string, fn: (...args: any[]) => void) => listeners.set(name, fn)),
    once: vi.fn((name: string, fn: (...args: any[]) => void) => listeners.set(name, fn)),
    isDestroyed: vi.fn(() => destroyed),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    show: vi.fn(),
    setBackgroundColor: vi.fn(),
    setMenu: vi.fn(),
    loadURL: vi.fn(async (_url: string) => {}),
    webContents: {
      on: vi.fn((name: string, fn: (...args: any[]) => void) => webListeners.set(name, fn)),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
      },
    },
  };
  return { target, window: target as unknown as Electron.BrowserWindow, listeners, webListeners };
}

const styleHash = createHash("sha256").update(DESKTOP_STARTUP_STYLE).digest("base64");

describe("DesktopStartupDocument", () => {
  it("admits only the exact inert stylesheet and fixed public copy", () => {
    const document = createDesktopStartupDocument("migrating", styleHash);
    assert.include(document, `style-src 'sha256-${styleHash}'`);
    assert.include(document, "default-src 'none'");
    assert.include(document, "script-src 'none'");
    assert.include(document, "connect-src 'none'");
    assert.include(document, "Updating your workspace…");
    assert.notInclude(document, "<script");
    assert.notInclude(document, "<img");
    assert.notInclude(document, "iframe");
    assert.notInclude(document, 'style="');
    assert.notInclude(document, "migrationId");
    assert.include(document, "prefers-reduced-motion");
    assert.include(document, "prefers-color-scheme: dark");
    assert.throws(() => createDesktopStartupDocument("starting", "';script-src *"));
    // Even a malformed internal phase cannot interpolate arbitrary text into
    // this document. Native progress is independently validated at ingress.
    const malformed = createDesktopStartupDocument("<script>secret" as "starting", styleHash);
    assert.notInclude(malformed, "secret");
    assert.include(malformed, "Starting…");
  });
});

describe("DesktopStartupWindow", () => {
  it.effect("does not flash a window for a startup completed inside the delay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let creates = 0;
        const quitting = yield* Ref.make(false);
        const status = yield* makeDesktopStartupWindow({
          create: () =>
            Effect.sync(() => {
              creates += 1;
              return fakeWindow().window;
            }),
          appearance: Effect.succeed({ dark: true, scalePercent: 100 }),
          onThemeUpdated: () => Effect.void,
          requestQuit: Effect.die("a fast startup must not request quit"),
          quitting,
        });
        yield* status.begin;
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(100));
        yield* status.close;
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(creates, 0);
      }),
    ),
  );

  it.effect("renders bounded phase changes with no preload, permission or network authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = fakeWindow();
        let options: Electron.BrowserWindowConstructorOptions | undefined;
        let quits = 0;
        const quitting = yield* Ref.make(false);
        const status = yield* makeDesktopStartupWindow({
          create: (value) =>
            Effect.sync(() => {
              options = value;
              return fixture.window;
            }),
          appearance: Effect.succeed({ dark: true, scalePercent: 130 }),
          onThemeUpdated: () => Effect.void,
          requestQuit: Effect.sync(() => {
            quits += 1;
          }),
          quitting,
        });
        yield* status.begin;
        yield* Effect.yieldNow;
        yield* status.update({ phase: "migrating", migrationId: 92 });
        yield* TestClock.adjust(Duration.millis(250));
        assert.equal(fixture.target.loadURL.mock.calls.length, 1);
        const document = decodeURIComponent(
          fixture.target.loadURL.mock.calls[0]![0].split(",")[1]!,
        );
        assert.include(document, "Updating your workspace…");
        assert.notInclude(document, "92");
        assert.equal(options?.webPreferences?.preload, undefined);
        assert.equal(options?.webPreferences?.javascript, false);
        assert.equal(options?.webPreferences?.sandbox, true);
        assert.equal(options?.webPreferences?.nodeIntegration, false);
        assert.equal(options?.webPreferences?.nodeIntegrationInSubFrames, false);
        assert.match(options?.webPreferences?.partition ?? "", /^cafe-startup-/);
        assert.notInclude(options?.webPreferences?.partition ?? "", "persist:");
        assert.deepEqual(fixture.target.webContents.setZoomFactor.mock.calls, [[1.3]]);
        assert.equal(fixture.target.show.mock.calls.length, 0);
        fixture.listeners.get("ready-to-show")?.();
        assert.equal(fixture.target.show.mock.calls.length, 1);
        getAllWindowsMock.mockReturnValue([fixture.window]);
        getFocusedWindowMock.mockReturnValue(fixture.window);
        yield* Effect.gen(function* () {
          const windows = yield* ElectronWindow.ElectronWindow;
          assert.equal((yield* windows.currentMainOrFirst)._tag, "None");
          assert.equal((yield* windows.focusedMainOrFirst)._tag, "None");
          yield* windows.sendAll("main-only");
          yield* windows.syncAllAppearance(() =>
            Effect.die("startup must not become a main/dictation/theme target"),
          );
        }).pipe(Effect.provide(ElectronWindow.layer));
        const requestPermission =
          fixture.target.webContents.session.setPermissionRequestHandler.mock.calls[0]![0]!;
        let allowed = true;
        requestPermission(null, "media", (result: boolean) => {
          allowed = result;
        });
        assert.equal(allowed, false);
        assert.equal(
          fixture.target.webContents.session.setPermissionCheckHandler.mock.calls[0]![0]!(),
          false,
        );
        const preventDefault = vi.fn();
        fixture.webListeners.get("will-navigate")?.({ preventDefault }, "https://provider.invalid");
        assert.equal(preventDefault.mock.calls.length, 1);
        assert.deepEqual(fixture.target.webContents.setWindowOpenHandler.mock.calls[0]![0]!(), {
          action: "deny",
        });
        yield* status.update({ phase: "migrating", migrationId: 93 });
        assert.equal(
          fixture.target.loadURL.mock.calls.length,
          1,
          "numeric progress must not reload the UI",
        );
        yield* status.update({ phase: "ready" });
        assert.equal(fixture.target.loadURL.mock.calls.length, 2);
        yield* status.close;
        assert.equal(fixture.target.destroy.mock.calls.length, 1);
        assert.equal(quits, 0, "main-window reveal disposal is not a user quit");
        fixture.listeners.get("ready-to-show")?.();
        yield* status.update({ phase: "starting" });
        assert.equal(fixture.target.show.mock.calls.length, 1);
        assert.equal(fixture.target.loadURL.mock.calls.length, 2);
      }),
    ),
  );

  it.effect(
    "routes user close to ordinary Quit and removes the auxiliary view on finalization",
    () =>
      Effect.gen(function* () {
        const fixture = fakeWindow();
        const quitting = yield* Ref.make(false);
        const quitRequested = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const status = yield* makeDesktopStartupWindow({
              create: () => Effect.succeed(fixture.window),
              appearance: Effect.succeed({ dark: false, scalePercent: 80 }),
              onThemeUpdated: () => Effect.void,
              requestQuit: Deferred.succeed(quitRequested, undefined).pipe(Effect.asVoid),
              quitting,
            });
            yield* status.begin;
            yield* Effect.yieldNow;
            yield* TestClock.adjust(Duration.millis(250));
            const preventDefault = vi.fn();
            fixture.listeners.get("close")?.({ preventDefault });
            yield* Deferred.await(quitRequested);
            assert.equal(preventDefault.mock.calls.length, 1);
            assert.equal(fixture.target.destroy.mock.calls.length, 0);
          }),
        );
        assert.equal(fixture.target.destroy.mock.calls.length, 1);
        assert.deepEqual(fixture.target.webContents.setZoomFactor.mock.calls, [[0.8]]);
      }),
  );

  it.effect("cancels the delayed window when quitting before paint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let creates = 0;
        const quitting = yield* Ref.make(false);
        const status = yield* makeDesktopStartupWindow({
          create: () =>
            Effect.sync(() => {
              creates += 1;
              return fakeWindow().window;
            }),
          appearance: Effect.succeed({ dark: false, scalePercent: 100 }),
          onThemeUpdated: () => Effect.void,
          requestQuit: Effect.void,
          quitting,
        });
        yield* status.begin;
        yield* Effect.yieldNow;
        yield* Ref.set(quitting, true);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(creates, 0);
      }),
    ),
  );
});
