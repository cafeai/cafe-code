import { assert, describe, it } from "@effect/vitest";

import {
  desktopSmokeChromiumSwitches,
  hasWindowsProviderOwnershipEvidence,
  isReadyDesktopDebugSnapshot,
  parseRuntimeSmokeArgs,
  readDebugUrl,
  resolvePackagedResourcesPath,
  summarizeDesktopDebugReadiness,
  summarizeRuntimeSelfTestFailure,
} from "./native-desktop-runtime-smoke.ts";

describe("native desktop runtime smoke", () => {
  it("retains only fixed runtime failure checks and bounded child stderr", () => {
    const failure = summarizeRuntimeSelfTestFailure(
      {
        exitCode: 1,
        signal: null,
        stdout: [
          "private-output",
          "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=ready:start",
          "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=ready:complete",
          "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=safeStorage:start",
          "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=private-output:start",
        ].join("\n"),
        stderr: "x".repeat(5_000),
      },
      {
        checks: { safeStorage: false, sqlite: true, pty: "unknown", other: "private-check" },
        failedChecks: ["safeStorage", "bootstrap", "private-check"],
        other: "private-metadata",
      },
    );
    assert.deepEqual(failure, {
      exitCode: 1,
      signal: null,
      checks: {
        safeStorage: false,
        sqlite: true,
        pty: null,
        packagedResources: null,
        packagedArtifactAudit: null,
        updateMetadata: null,
        managedRuntime: null,
      },
      failedChecks: ["safeStorage", "bootstrap"],
      phases: [
        "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=ready:start",
        "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=ready:complete",
        "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=safeStorage:start",
      ],
      stderr: "x".repeat(4_096),
    });
    const missing = summarizeRuntimeSelfTestFailure(
      { exitCode: null, signal: "SIGTRAP", stdout: "", stderr: "native startup failure" },
      undefined,
    );
    assert.equal(missing.signal, "SIGTRAP");
    assert.equal(missing.stderr, "native startup failure");
    assert.deepEqual(missing.failedChecks, []);
    assert.deepEqual(missing.phases, []);
    assert.deepEqual(Object.values(missing.checks), Array(7).fill(null));
    const repeated = summarizeRuntimeSelfTestFailure(
      {
        exitCode: 1,
        signal: null,
        stdout: "CAFE_CODE_RUNTIME_SELF_TEST_PHASE=ready:start\n".repeat(30),
        stderr: "",
      },
      undefined,
    );
    assert.equal(repeated.phases.length, 16);
  });

  it("requires exact authenticated Windows identity plus generation for new Windows artifact readiness", () => {
    const health = {
      ok: true,
      pid: 27,
      windowsProcessIdentity: { pid: 27, creationTime100ns: "134348901321234567" },
      windowsOwnershipId: "9a90b48d-868f-4614-ae9c-66d50293d52b",
    };
    assert.isTrue(hasWindowsProviderOwnershipEvidence({ providerDaemon: { lastHealth: health } }));
    for (const invalid of [
      {},
      { ...health, windowsOwnershipId: undefined },
      { ...health, windowsOwnershipId: "not-a-generation" },
      { ...health, windowsProcessIdentity: undefined },
      { ...health, windowsProcessIdentity: { pid: 28, creationTime100ns: "134348901321234567" } },
      {
        ...health,
        windowsProcessIdentity: { pid: 27, creationTime100ns: Number("134348901321234567") },
      },
      { ...health, windowsProcessIdentity: { pid: 27, creationTime100ns: "18446744073709551616" } },
    ])
      assert.isFalse(
        hasWindowsProviderOwnershipEvidence({ providerDaemon: { lastHealth: invalid } }),
      );
  });

  it("reads the actual full debug wrappers without relaxing packaged Windows readiness", () => {
    // DesktopDebugServer.buildFullDebugSnapshot wraps both raw snapshots;
    // unlike compact debug, the outer objects expose availability only.
    const health = {
      ok: true,
      pid: 27,
      windowsProcessIdentity: { pid: 27, creationTime100ns: "134348901321234567" },
      windowsOwnershipId: "9a90b48d-868f-4614-ae9c-66d50293d52b",
    };
    const full = {
      schemaVersion: 1,
      debug: { detail: "full" },
      providerDaemon: {
        available: true,
        snapshot: { status: "running", lastHealth: health },
      },
      renderer: {
        available: true,
        snapshot: {
          diagnostics: { localApi: { available: true } },
          connection: { connected: true },
        },
        history: [],
      },
    };
    assert.deepEqual(summarizeDesktopDebugReadiness(full), {
      providerAvailable: true,
      providerStatus: "running",
      providerHealthOk: true,
      rendererAvailable: true,
      rendererLocalApiAvailable: true,
      rendererWebSocketConnected: true,
    });
    assert.isTrue(isReadyDesktopDebugSnapshot(full));
    assert.isTrue(hasWindowsProviderOwnershipEvidence(full));
    assert.isFalse(
      isReadyDesktopDebugSnapshot({
        ...full,
        renderer: { ...full.renderer, available: false },
      }),
    );
    assert.isFalse(
      isReadyDesktopDebugSnapshot({
        ...full,
        renderer: {
          ...full.renderer,
          snapshot: { ...full.renderer.snapshot, connection: { connected: false } },
        },
      }),
    );
    for (const invalidHealth of [
      { ...health, ok: false },
      { ...health, windowsOwnershipId: undefined },
      { ...health, windowsProcessIdentity: { ...health.windowsProcessIdentity, pid: 28 } },
    ])
      assert.isFalse(
        hasWindowsProviderOwnershipEvidence({
          ...full,
          providerDaemon: {
            ...full.providerDaemon,
            snapshot: { ...full.providerDaemon.snapshot, lastHealth: invalidHealth },
          },
        }),
      );
  });

  it("does not substitute compact fields for a malformed full snapshot", () => {
    const invalidFull = {
      providerDaemon: { available: true, snapshot: null, lastHealth: { ok: true } },
      renderer: {
        available: true,
        snapshot: [],
        diagnostics: { localApi: { available: true } },
        connection: { connected: true },
      },
    };
    assert.isFalse(isReadyDesktopDebugSnapshot(invalidFull));
    assert.isFalse(hasWindowsProviderOwnershipEvidence(invalidFull));
    assert.deepEqual(summarizeDesktopDebugReadiness(invalidFull), {
      providerAvailable: true,
      providerStatus: null,
      providerHealthOk: false,
      rendererAvailable: true,
      rendererLocalApiAvailable: false,
      rendererWebSocketConnected: false,
    });
  });

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
