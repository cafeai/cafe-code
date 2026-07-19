import { assert, describe, it } from "@effect/vitest";

import {
  desktopSmokeChromiumSwitches,
  isReadyDesktopDebugSnapshot,
  parseRuntimeSmokeArgs,
  readDebugUrl,
  resolvePackagedResourcesPath,
  summarizeDesktopDebugReadiness,
} from "./native-desktop-runtime-smoke.ts";

describe("native desktop runtime smoke", () => {
  it("parses explicit app and resource paths", () => {
    const options = parseRuntimeSmokeArgs(["--app", "./Cafe Code", "--resources", "./Resources"]);
    assert.match(options.appPath, /Cafe Code$/);
    assert.match(options.resourcesPath ?? "", /Resources$/);
  });

  it("derives native packaged resource locations", () => {
    assert.equal(
      resolvePackagedResourcesPath("C:\\Cafe\\Cafe Code.exe", "win32"),
      "C:\\Cafe\\resources",
    );
    assert.equal(
      resolvePackagedResourcesPath(
        "/Applications/Cafe Code.app/Contents/MacOS/Cafe Code",
        "darwin",
      ),
      "/Applications/Cafe Code.app/Contents/Resources",
    );
  });

  it("extracts only a loopback desktop debug endpoint", () => {
    assert.equal(
      readDebugUrl("noise [Cafe Code debug] http://127.0.0.1:4567/debug more"),
      "http://127.0.0.1:4567/debug",
    );
    assert.isUndefined(readDebugUrl("[Cafe Code debug] http://192.0.2.1:4567/debug"));
  });

  it("disables Chromium sandboxing only for an explicit container smoke", () => {
    assert.deepEqual(desktopSmokeChromiumSwitches({}), []);
    assert.deepEqual(
      desktopSmokeChromiumSwitches({ CAFE_CODE_NATIVE_SMOKE_DISABLE_CHROMIUM_SANDBOX: "1" }),
      ["--no-sandbox"],
    );
  });

  it("requires provider health and a hydrated renderer IPC surface", () => {
    assert.isTrue(
      isReadyDesktopDebugSnapshot({
        providerDaemon: { available: true, lastHealth: { ok: true } },
        renderer: {
          available: true,
          diagnostics: { localApi: { available: true } },
          connection: { connected: true },
        },
      }),
    );
    assert.isFalse(
      isReadyDesktopDebugSnapshot({
        providerDaemon: { available: true, lastHealth: { ok: true } },
        renderer: {
          available: true,
          diagnostics: { localApi: { available: true } },
          connection: { connected: false },
        },
      }),
    );
    assert.isFalse(
      isReadyDesktopDebugSnapshot({
        providerDaemon: { available: true, lastHealth: { ok: true } },
        renderer: { available: false },
      }),
    );
    assert.deepEqual(
      summarizeDesktopDebugReadiness({
        providerDaemon: { available: true, status: "running", lastHealth: { ok: false } },
        renderer: { available: false },
      }),
      {
        providerAvailable: true,
        providerStatus: "running",
        providerHealthOk: false,
        rendererAvailable: false,
        rendererLocalApiAvailable: false,
        rendererWebSocketConnected: false,
      },
    );
  });
});
