import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopProviderDaemonManager from "./DesktopProviderDaemonManager.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

const PersistedServerObservabilitySettingsDocument = Schema.Struct({
  observability: Schema.Struct({
    otlpTracesUrl: Schema.String,
    otlpMetricsUrl: Schema.String,
  }),
});

const encodePersistedServerObservabilitySettingsDocument = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerObservabilitySettingsDocument),
);

const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    httpsPort: 4890,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    httpsBaseUrl: new URL("https://127.0.0.1:4890"),
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setHttpsEnabled: () => Effect.die("unexpected setHttpsEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposureShape);

const serverExposureWithoutHttpsLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    httpsPort: undefined,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    httpsBaseUrl: undefined,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setHttpsEnabled: () => Effect.die("unexpected setHttpsEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposureShape);

const providerDaemonLayer = Layer.succeed(
  DesktopProviderDaemonManager.DesktopProviderDaemonManager,
  {
    ensureRunning: Effect.succeed({
      httpBaseUrl: "http://127.0.0.1:3774",
      token: "provider-daemon-test-token-000000000000000000000000",
    }),
    currentConfig: Effect.succeed(Option.none()),
    refreshHealth: Effect.succeed(Option.none()),
    snapshot: Effect.succeed({
      status: "idle",
      pid: Option.none(),
      endpoint: Option.none(),
      adoptedExistingProcess: false,
      lastHealth: Option.none(),
      lastError: Option.none(),
      markerPath: "/tmp/provider-daemon.json",
      credentialPath: "/tmp/provider-daemon-token.bin",
      runtimeBuildId: "test-runtime-build-id",
      lastEnsureRunningDurationMs: Option.none(),
      lastAdoptionDurationMs: Option.none(),
      lastSpawnDurationMs: Option.none(),
      lastHealthRefreshDurationMs: Option.none(),
      healthRefreshCount: 0,
      healthRefreshFailureCount: 0,
    }),
    stop: Effect.void,
  } satisfies DesktopProviderDaemonManager.DesktopProviderDaemonManagerShape,
);

function makeEnvironmentLayer(
  baseDir: string,
  options?: {
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
  },
) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          CAFE_CODE_HOME: baseDir,
          CAFE_CODE_PORT: "9999",
          CAFE_CODE_MODE: "desktop",
          CAFE_CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
        }),
      ),
    ),
  );
}

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
  options?: {
    readonly providerDaemonLayer?: Layer.Layer<DesktopProviderDaemonManager.DesktopProviderDaemonManager>;
    readonly serverExposureLayer?: Layer.Layer<DesktopServerExposure.DesktopServerExposure>;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(options?.serverExposureLayer ?? serverExposureLayer),
          Layer.provideMerge(options?.providerDaemonLayer ?? providerDaemonLayer),
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it.effect("resolves backend start config with a stable scoped bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const first = yield* configuration.resolve;
        const second = yield* configuration.resolve;

        assert.equal(first.executablePath, process.execPath);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.equal(first.env.CAFE_CODE_SHELL_ENV_HYDRATED, "1");
        assert.isUndefined(first.env.CAFE_CODE_PORT);
        assert.isUndefined(first.env.CAFE_CODE_HTTPS_ENABLED);
        assert.isUndefined(first.env.CAFE_CODE_HTTPS_PORT);
        assert.isUndefined(first.env.CAFE_CODE_MODE);
        assert.isUndefined(first.env.CAFE_CODE_DESKTOP_LAN_HOST);
        assert.isUndefined(first.env.CAFE_CODE_DESKTOP_DEV);
        assert.isUndefined(first.env.CAFE_CODE_DEV_URL);
        assert.isUndefined(first.env.VITE_DEV_SERVER_URL);

        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.httpsPort, 4890);
        assert.equal(first.bootstrap.host, "0.0.0.0");
        assert.equal(first.bootstrap.cafeCodeHome, environment.baseDir);
        assert.match(first.bootstrap.desktopBootstrapToken, /^[0-9a-f]{48}$/i);
        assert.equal(second.bootstrap.desktopBootstrapToken, first.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("disables backend HTTPS through child env when desktop exposure has no HTTPS port", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;

        assert.equal(config.env.CAFE_CODE_HTTPS_ENABLED, "false");
        assert.isUndefined(config.env.CAFE_CODE_HTTPS_PORT);
        assert.isUndefined(config.bootstrap.httpsPort);
      }),
      {
        serverExposureLayer: serverExposureWithoutHttpsLayer,
      },
    ),
  );

  it.effect("includes persisted backend observability endpoints when present", () =>
    withHarness(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
            },
          }),
        );

        const config = yield* configuration.resolve;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
      }),
    ),
  );

  it.effect("omits backend observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;

        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      }),
    ),
  );

  it.effect("includes provider daemon endpoint in desktop bootstrap when configured", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;

        assert.deepEqual(config.bootstrap.providerDaemon, {
          httpBaseUrl: "http://127.0.0.1:3774",
          token: "provider-daemon-test-token-000000000000000000000000",
        });
      }),
      {
        providerDaemonLayer: Layer.succeed(
          DesktopProviderDaemonManager.DesktopProviderDaemonManager,
          {
            ensureRunning: Effect.die("unexpected ensureRunning"),
            currentConfig: Effect.succeed(
              Option.some({
                httpBaseUrl: "http://127.0.0.1:3774",
                token: "provider-daemon-test-token-000000000000000000000000",
              }),
            ),
            refreshHealth: Effect.succeed(Option.none()),
            snapshot: Effect.die("unexpected snapshot"),
            stop: Effect.void,
          } satisfies DesktopProviderDaemonManager.DesktopProviderDaemonManagerShape,
        ),
      },
    ),
  );

  it.effect("captures backend output in development so child process logs can be persisted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolve;
        assert.equal(config.captureOutput, true);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(providerDaemonLayer),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                isPackaged: false,
                devServerUrl: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
