import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vitest";
import desktopPackageJson from "../../package.json" with { type: "json" };

const {
  appendSwitchMock,
  exitMock,
  getAppPathMock,
  getVersionMock,
  isPackagedState,
  onMock,
  quitMock,
  relaunchMock,
  removeListenerMock,
  requestSingleInstanceLockMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setDesktopNameMock,
  setDockIconMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  exitMock: vi.fn(),
  getAppPathMock: vi.fn(() => "/app"),
  getVersionMock: vi.fn(() => "1.2.3"),
  isPackagedState: { current: true },
  onMock: vi.fn(),
  quitMock: vi.fn(),
  relaunchMock: vi.fn(),
  removeListenerMock: vi.fn(),
  requestSingleInstanceLockMock: vi.fn(() => true),
  setAboutPanelOptionsMock: vi.fn(),
  setAppUserModelIdMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  setDockIconMock: vi.fn(),
  setNameMock: vi.fn(),
  setPathMock: vi.fn(),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
    },
    dock: {
      setIcon: setDockIconMock,
    },
    getAppPath: getAppPathMock,
    getVersion: getVersionMock,
    get isPackaged() {
      return isPackagedState.current;
    },
    name: "Cafe Code",
    on: onMock,
    quit: quitMock,
    relaunch: relaunchMock,
    removeListener: removeListenerMock,
    requestSingleInstanceLock: requestSingleInstanceLockMock,
    runningUnderARM64Translation: false,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
    exit: exitMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    exitMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    relaunchMock.mockClear();
    removeListenerMock.mockClear();
    requestSingleInstanceLockMock.mockClear();
    requestSingleInstanceLockMock.mockReturnValue(true);
    setPathMock.mockClear();
    getVersionMock.mockClear();
    getAppPathMock.mockClear();
    isPackagedState.current = true;
  });

  it.effect("reads app metadata through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.deepEqual(metadata, {
        appVersion: "1.2.3",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: process.resourcesPath,
        runningUnderArm64Translation: false,
      });
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes app event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.on("activate", listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["activate", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["activate", listener]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("requests the Electron single-instance lock", () =>
    Effect.gen(function* () {
      requestSingleInstanceLockMock.mockReturnValueOnce(false);

      const electronApp = yield* ElectronApp.ElectronApp;
      const acquired = yield* electronApp.requestSingleInstanceLock;

      assert.isFalse(acquired);
      assert.deepEqual(requestSingleInstanceLockMock.mock.calls, [[]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("uses package metadata for unpackaged Electron starts", () =>
    Effect.gen(function* () {
      isPackagedState.current = false;

      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.equal(metadata.appVersion, desktopPackageJson.version);
      assert.isFalse(metadata.isPackaged);
      assert.deepEqual(getVersionMock.mock.calls, []);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
