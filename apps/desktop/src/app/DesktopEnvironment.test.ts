import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Cafe Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Cafe Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    return yield* DesktopEnvironment.DesktopEnvironment;
  }).pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          CAFE_CODE_HOME: " /tmp/t3 ",
          CAFE_CODE_COMMIT_HASH: " 0123456789abcdef ",
          CAFE_CODE_DESKTOP_DEV: "true",
          CAFE_CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          CAFE_CODE_DEV_REMOTE_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          CAFE_CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          CAFE_CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );

      const path = environment.path;
      assert.equal(environment.isDevelopment, true);
      assert.equal(
        environment.appDataDirectory,
        path.join("/Users/alice", "Library", "Application Support"),
      );
      assert.equal(environment.baseDir, "/tmp/t3");
      assert.equal(environment.stateDir, path.join(environment.baseDir, "dev"));
      assert.equal(
        environment.desktopSettingsPath,
        path.join(environment.stateDir, "desktop-settings.json"),
      );
      assert.equal(
        environment.clientSettingsPath,
        path.join(environment.stateDir, "client-settings.json"),
      );
      assert.equal(
        environment.serverSettingsPath,
        path.join(environment.stateDir, "settings.json"),
      );
      assert.equal(environment.logDir, path.join(environment.stateDir, "logs"));
      assert.equal(environment.rootDir, path.resolve(defaultInput.dirname, "../../.."));
      assert.equal(environment.appRoot, environment.rootDir);
      assert.equal(
        environment.backendEntryPath,
        path.join(environment.appRoot, "apps/server/dist/bin.mjs"),
      );
      assert.equal(environment.backendCwd, environment.appRoot);
      assert.equal(
        environment.developmentDockIconPath,
        path.join(environment.rootDir, "assets", "app-icon", "cafe-code-app-icon-1024.png"),
      );
      assert.equal(environment.appUserModelId, "com.cafeai.cafecode.dev");
      assert.equal(environment.linuxWmClass, "cafecode-dev");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.devRemoteServerEntryPath, Option.some("/remote/server.mjs"));
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
    }),
  );

  it.effect("does not switch app identity to development from an inherited Vite URL", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          CAFE_CODE_HOME: "/tmp/t3",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, environment.path.join(environment.baseDir, "userdata"));
      assert.equal(environment.branding.stageLabel, "Alpha");
      assert.equal(environment.displayName, "Cafe Code (Alpha)");
      assert.equal(environment.userDataDirName, "cafecode");
      assert.equal(environment.appUserModelId, "com.cafeai.cafecode");
    }),
  );

  it.effect("derives production state paths under userdata", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          CAFE_CODE_HOME: "/tmp/t3",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, environment.path.join(environment.baseDir, "userdata"));
      assert.equal(environment.logDir, environment.path.join(environment.stateDir, "logs"));
      assert.equal(
        environment.serverSettingsPath,
        environment.path.join(environment.stateDir, "settings.json"),
      );
    }),
  );

  it.effect("defaults Cafe Code state to ~/.cafe-code", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.equal(environment.baseDir, environment.path.join("/Users/alice", ".cafe-code"));
      assert.equal(environment.stateDir, environment.path.join(environment.baseDir, "userdata"));
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some(environment.path.join("/Users/alice", "project")),
      );
    }),
  );
});
