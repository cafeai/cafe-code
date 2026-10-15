import { describe, expect, it } from "vitest";
import {
  configureNativeVisualizationFixtureDriver,
  hasOnlyKnownNativeFixtureDiagnostics,
  isSandboxedNativeFixtureDriver,
  nativeFixtureClippedCaptureObservation,
  nativeVisualizationFixtureDriver,
} from "./nativeVisualizationFixturePolicy.ts";

describe("isolated native fixture graphics policy", () => {
  it("selects only the fixed full driver for trusted synthetic Linux cases", () => {
    for (const kind of ["comprehensive", "synthetic-bar", "font"])
      expect(nativeVisualizationFixtureDriver("linux", kind)).toEqual([
        ["use-gl", "angle"],
        ["use-angle", "swiftshader"],
      ]);
    for (const kind of ["exact-bar", "received", "production", "", "synthetic-bar "])
      expect(nativeVisualizationFixtureDriver("linux", kind)).toEqual([]);
    for (const platform of ["darwin", "win32", "unknown", "Linux"])
      for (const kind of ["comprehensive", "synthetic-bar", "font", "exact-bar"])
        expect(nativeVisualizationFixtureDriver(platform, kind)).toEqual([]);
  });

  it("applies fixed switches before readiness without overriding unsafe or private-replay modes", () => {
    const calls: [string, string][] = [];
    const app = {
      isReady: () => false,
      commandLine: {
        hasSwitch: () => false,
        appendSwitch: (name: string, value: string) => {
          calls.push([name, value]);
        },
      },
    };
    expect(configureNativeVisualizationFixtureDriver(app, "linux", "comprehensive")).toBe(true);
    expect(calls).toEqual([
      ["use-gl", "angle"],
      ["use-angle", "swiftshader"],
    ]);
    calls.length = 0;
    expect(configureNativeVisualizationFixtureDriver(app, "linux", "exact-bar")).toBe(false);
    expect(configureNativeVisualizationFixtureDriver(app, "darwin", "synthetic-bar")).toBe(false);
    expect(calls).toEqual([]);
    expect(() =>
      configureNativeVisualizationFixtureDriver({ ...app, isReady: () => true }, "linux", "font"),
    ).toThrow("policy refused");
    for (const unsafe of [
      "use-gl",
      "use-angle",
      "no-sandbox",
      "disable-gpu-sandbox",
      "in-process-gpu",
      "single-process",
      "disable-web-security",
      "enable-unsafe-swiftshader",
    ])
      expect(() =>
        configureNativeVisualizationFixtureDriver(
          { ...app, commandLine: { ...app.commandLine, hasSwitch: (name) => name === unsafe } },
          "linux",
          "synthetic-bar",
        ),
      ).toThrow("policy refused");
    expect(calls).toEqual([]);
  });

  it("requires actual out-of-process sandboxed native driver identity", () => {
    const auxiliary = {
      sandboxed: true,
      inProcessGpu: false,
      glImplementationParts: "(gl=egl-angle,angle=swiftshader)",
    };
    expect(isSandboxedNativeFixtureDriver({ auxAttributes: auxiliary })).toBe(true);
    for (const changed of [
      { sandboxed: false },
      { sandboxed: undefined },
      { sandboxed: "true" },
      { inProcessGpu: true },
      { inProcessGpu: undefined },
      { glImplementationParts: "(gl=egl-angle,angle=swiftshader-webgl)" },
      { glImplementationParts: "(gl=egl-angle,angle=default)" },
      { glImplementationParts: "(gl=egl-angle,angle=swiftshader) private" },
    ])
      expect(isSandboxedNativeFixtureDriver({ auxAttributes: { ...auxiliary, ...changed } })).toBe(
        false,
      );
    for (const value of [null, [], {}, { auxAttributes: null }, { auxAttributes: [] }])
      expect(isSandboxedNativeFixtureDriver(value)).toBe(false);
  });
});

describe("exact native fixture stderr classification", () => {
  const connection =
    '[19352:1013/065532.863212:ERROR:dbus/bus.cc:406] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")';
  const owner =
    "[19352:1013/065532.952547:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ";
  it("admits only the two preserved fixed Linux observations", () => {
    expect(hasOnlyKnownNativeFixtureDiagnostics(`${connection}\r\n${owner}\n`, "linux")).toBe(true);
    expect(hasOnlyKnownNativeFixtureDiagnostics(" \n\r\n", "linux")).toBe(true);
    for (const platform of ["darwin", "win32", "unknown"])
      expect(hasOnlyKnownNativeFixtureDiagnostics(`${connection}\n`, platform)).toBe(false);
  });
  it("refuses unknown native errors, fixture errors, altered payloads and oversized streams", () => {
    for (const line of [
      connection.replace("bus.cc:406", "bus.cc:407"),
      connection.replace("ERROR", "FATAL"),
      connection.replace("Unknown address type", "private source sentinel"),
      owner.replace("org.freedesktop.DBus.NameHasOwner", "org.private.Method"),
      owner.trimEnd(),
      "[19512:1013/065538.767553:ERROR:gpu/command_buffer/service/context_group.cc:146] ContextResult::kFatalFailure: WebGL2 blocklisted",
      "[19517:1013/065538.726764:ERROR:net/socket/ssl_client_socket_impl.cc:924] handshake failed; returned -1, SSL error code 1, net_error -2",
      "[19553:1013/065545.490700:FATAL:content/child/child_thread_impl.cc:377] Crashing because hung",
      "Native bar fixture exception.",
      "Native font fixture qualification unavailable.",
      `${connection}\u0000`,
      `${connection}\nprivate received JSON`,
    ])
      expect(hasOnlyKnownNativeFixtureDiagnostics(`${connection}\n${line}\n`, "linux")).toBe(false);
    expect(hasOnlyKnownNativeFixtureDiagnostics(`${connection}\n`.repeat(128), "linux")).toBe(
      false,
    );
    expect(hasOnlyKnownNativeFixtureDiagnostics(" ".repeat(65_537), "linux")).toBe(false);
    expect(hasOnlyKnownNativeFixtureDiagnostics("界".repeat(30_000), "linux")).toBe(false);
  });
  it("admits the exact Linux retirement message only once for every positively witnessed native PID", () => {
    const crash =
      "[19553:1013/065545.490700:FATAL:content/child/child_thread_impl.cc:377] Crashing because hung";
    expect(
      hasOnlyKnownNativeFixtureDiagnostics(`${connection}\n${crash}\n`, "linux", [19553]),
    ).toBe(true);
    for (const witnesses of [
      [],
      undefined,
      null,
      [19554],
      [0],
      [Infinity],
      ["19553"],
      [19553, 19553],
      [19553, 19554],
      [19553, 2, 3, 4],
      new Array(1),
    ])
      expect(hasOnlyKnownNativeFixtureDiagnostics(`${crash}\n`, "linux", witnesses)).toBe(false);
    for (const line of [
      crash.replace("19553", "19479"),
      crash.replace("FATAL", "ERROR"),
      crash.replace("377", "378"),
      crash.replace("child_thread_impl", "gpu_thread_impl"),
      `${crash} private`,
      `${crash}\n${crash}`,
      "[19553:1013/065545.490700:ERROR:net/socket/ssl_client_socket_impl.cc:924] handshake failed; returned -1, SSL error code 1, net_error -2",
    ])
      expect(hasOnlyKnownNativeFixtureDiagnostics(`${line}\n`, "linux", [19553])).toBe(false);
    expect(hasOnlyKnownNativeFixtureDiagnostics("", "linux", [19553])).toBe(false);
    expect(hasOnlyKnownNativeFixtureDiagnostics(`${connection}\n`, "linux", [19553])).toBe(false);
    for (const platform of ["darwin", "win32", "unknown"])
      expect(hasOnlyKnownNativeFixtureDiagnostics(`${crash}\n`, platform, [19553])).toBe(false);
  });
});

it("bounds clipped capture observations without received strings or nonfinite values", () => {
  const complete = {
    ownerZoom: 0.8,
    displayDpr: 1,
    expectedWidth: 480,
    expectedHeight: 320,
    capturePresent: true,
    reportedWidth: 480,
    reportedHeight: 320,
    encodedWidth: 480,
    encodedHeight: 320,
    sampleBgra: [0, 0, 0, 255],
    captureOutcome: "ready",
  };
  expect(nativeFixtureClippedCaptureObservation(complete)).toEqual(complete);
  expect(
    nativeFixtureClippedCaptureObservation({
      ownerZoom: Infinity,
      displayDpr: "private",
      expectedWidth: 1601,
      expectedHeight: -1,
      capturePresent: false,
      reportedWidth: NaN,
      reportedHeight: 2001,
      encodedWidth: "private",
      encodedHeight: 1.5,
      sampleBgra: [0, 0, 0, 256],
      captureOutcome: "private JSON",
    }),
  ).toEqual({
    ownerZoom: null,
    displayDpr: null,
    expectedWidth: null,
    expectedHeight: null,
    capturePresent: false,
    reportedWidth: null,
    reportedHeight: null,
    encodedWidth: null,
    encodedHeight: null,
    sampleBgra: null,
    captureOutcome: "unknown",
  });
  const observation = nativeFixtureClippedCaptureObservation({
    ...complete,
    sampleBgra: new Uint8Array([0, 0, 0, 255]),
  });
  expect(observation.sampleBgra).toBeNull();
  expect(Object.keys(observation)).toHaveLength(11);
  expect(
    nativeFixtureClippedCaptureObservation({ ...complete, sampleBgra: new Array(4) }).sampleBgra,
  ).toBeNull();
  const annotated = Object.assign([0, 0, 0, 255], { toJSON: () => "private JSON sentinel" });
  const copied = nativeFixtureClippedCaptureObservation({ ...complete, sampleBgra: annotated });
  expect(copied.sampleBgra).toEqual([0, 0, 0, 255]);
  expect(copied.sampleBgra).not.toBe(annotated);
  expect(JSON.stringify(copied)).not.toContain("private");
});
