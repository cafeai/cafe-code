import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  DesktopEnvironment,
  layer as makeDesktopEnvironmentLayer,
} from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import type { DesktopNetworkInterfaces } from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const emptyNetworkInterfaces: DesktopNetworkInterfaces = {};
const lanNetworkInterfaces: DesktopNetworkInterfaces = {
  en0: [
    {
      address: "192.168.1.20",
      family: "IPv4",
      internal: false,
    },
  ],
};

function makeEnvironmentLayer(baseDir: string, env: Record<string, string | undefined> = {}) {
  return makeDesktopEnvironmentLayer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ CAFE_CODE_HOME: baseDir, ...env }),
      ),
    ),
  );
}

function makeLayer(input: {
  readonly baseDir: string;
  readonly networkInterfaces?: DesktopNetworkInterfaces;
  readonly env?: Record<string, string | undefined>;
}) {
  const env = { CAFE_CODE_HOME: input.baseDir, ...input.env };
  const environmentLayer = makeEnvironmentLayer(input.baseDir, env);
  const networkLayer = Layer.succeed(DesktopServerExposure.DesktopNetworkInterfacesService, {
    read: Effect.succeed(input.networkInterfaces ?? emptyNetworkInterfaces),
  });

  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(DesktopAppSettings.layer),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(networkLayer),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(environmentLayer),
  );
}

const withHarness = <A, E, R>(
  networkInterfaces: DesktopNetworkInterfaces,
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopServerExposure.DesktopServerExposure
    | DesktopAppSettings.DesktopAppSettings
  >,
  env: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-server-exposure-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer({ baseDir, networkInterfaces, env })));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopServerExposure", () => {
  it.effect("falls back to local-only without losing the requested network preference", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");
      }),
    ),
  );

  it.effect("returns a typed error when network access is explicitly unavailable", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const error = yield* serverExposure.setMode("network-accessible").pipe(Effect.flip);
        assert.ok(error._tag === "DesktopServerExposureNoNetworkAddressError");
        assert.equal(error.port, 4173);
      }),
    ),
  );

  it.effect("persists network-accessible mode and updates backend binding state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.requiresRelaunch, true);
        assert.deepEqual(change.state, {
          mode: "network-accessible",
          httpsEnabled: true,
          endpointUrl: "http://192.168.1.20:4173",
          advertisedHost: "192.168.1.20",
        });

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "0.0.0.0");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");

        const persisted = yield* settings.get;
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("resolves advertised endpoints from the scoped runtime state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/"],
        );
      }),
    ),
  );

  it.effect("advertises HTTPS and WSS endpoints when a sibling HTTPS port is configured", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173, httpsPort: 4175 });
        yield* serverExposure.setMode("network-accessible");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.httpsPort, 4175);
        assert.equal(backendConfig.httpsBaseUrl?.href, "https://127.0.0.1:4175/");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => [
            endpoint.httpBaseUrl,
            endpoint.wsBaseUrl,
            endpoint.isDefault,
          ]),
          [
            ["https://127.0.0.1:4175/", "wss://127.0.0.1:4175/", false],
            ["https://192.168.1.20:4175/", "wss://192.168.1.20:4175/", true],
          ],
        );
      }),
    ),
  );

  it.effect("disables HTTPS without changing the requested network exposure mode", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* serverExposure.configureFromSettings({ port: 4173, httpsPort: 4175 });
        yield* serverExposure.setMode("network-accessible");

        const change = yield* serverExposure.setHttpsEnabled(false);
        assert.equal(change.requiresRelaunch, true);
        assert.deepEqual(change.state, {
          mode: "network-accessible",
          httpsEnabled: false,
          endpointUrl: "http://192.168.1.20:4173",
          advertisedHost: "192.168.1.20",
        });

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.httpsPort, undefined);
        assert.equal(backendConfig.httpsBaseUrl, undefined);

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/"],
        );
        assert.equal((yield* settings.get).serverHttpsEnabled, false);
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("uses ConfigProvider desktop exposure overrides", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setMode("network-accessible");

        assert.equal(change.state.advertisedHost, "10.0.0.7");
        assert.equal(change.state.endpointUrl, "http://10.0.0.7:4173");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://10.0.0.7:4173/", "https://public.example.test/"],
        );
      }),
      {
        CAFE_CODE_DESKTOP_LAN_HOST: "10.0.0.7",
        CAFE_CODE_DESKTOP_HTTPS_ENDPOINTS: "https://public.example.test",
      },
    ),
  );

  it.effect("advertises loopback, LAN, and configured manual endpoints from runtime state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 3773 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(endpoints, [
          {
            id: "desktop-loopback:http://127.0.0.1:3773",
            label: "This machine",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            reachability: "loopback",
            source: "desktop-core",
            status: "available",
            isDefault: false,
            description: "Loopback endpoint for this desktop app.",
          },
          {
            id: "desktop-lan:http://192.168.1.20:3773",
            label: "Local network",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://192.168.1.20:3773/",
            wsBaseUrl: "ws://192.168.1.20:3773/",
            reachability: "lan",
            source: "desktop-core",
            status: "available",
            isDefault: true,
            description: "Reachable from devices on the same network.",
          },
          {
            id: "manual:https://desktop.example.ts.net",
            label: "Custom HTTPS",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "https://desktop.example.ts.net/",
            wsBaseUrl: "wss://desktop.example.ts.net/",
            reachability: "public",
            source: "user",
            status: "unknown",
            description: "User-configured HTTPS endpoint for this desktop backend.",
          },
          {
            id: "manual:http://desktop.example.test:3773",
            label: "Custom endpoint",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "http://desktop.example.test:3773/",
            wsBaseUrl: "ws://desktop.example.test:3773/",
            reachability: "public",
            source: "user",
            status: "unknown",
            description: "User-configured endpoint for this desktop backend.",
          },
        ]);
      }),
      {
        CAFE_CODE_DESKTOP_HTTPS_ENDPOINTS:
          "https://desktop.example.ts.net,http://desktop.example.test:3773,not-a-url",
      },
    ),
  );
});
