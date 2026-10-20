// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { openSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NetService from "@cafecode/shared/Net";
import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as Bootstrap,
} from "@cafecode/contracts";
import { deriveServerPaths } from "../config.ts";
import { resolveServerConfig, type CliServerFlags } from "./config.ts";
import { resolveProviderDaemonServerConfig } from "./providerDaemon.ts";

const flags = (overrides: Partial<CliServerFlags> = {}): CliServerFlags => ({
  mode: Option.some("desktop"),
  port: Option.some(4888),
  httpsPort: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.some(true),
  noHttps: Option.some(true),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  ...overrides,
});

const configured = (env: Record<string, string> = {}) =>
  Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer);

it.layer(NodeServices.layer)("explicit data profiles", (it) => {
  it.effect(
    "keeps Debug listeners separate and private while preserving explicit network and legacy defaults",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-listeners-" });
        const probes: Array<{ port: number; host: string }> = [];
        const legacySelections: number[] = [];
        const net = Layer.succeed(NetService.NetService, {
          ...NetService.make(),
          canListenOnHost: (port, host) =>
            Effect.sync(() => {
              probes.push({ port, host });
              // Release's default is free: Debug must not claim it. The Debug
              // preference is occupied, so native admission must move upward.
              return port !== 13773;
            }),
          findAvailablePort: (preferred) =>
            Effect.sync(() => {
              legacySelections.push(preferred);
              return preferred;
            }),
        });
        const resolve = (overrides: Partial<CliServerFlags>) =>
          resolveServerConfig(
            flags({ baseDir: Option.some(root), port: Option.none(), ...overrides }),
            Option.none(),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), net),
            ),
          );
        const debug = yield* resolve({
          dataProfile: Option.some("debug"),
          mode: Option.some("web"),
          noHttps: Option.some(false),
        });
        expect(debug.port).toBe(13774);
        expect(debug.httpsPort).toBe(13775);
        expect(debug.host).toBe("127.0.0.1");
        expect(probes.some(({ port }) => port === 3773)).toBe(false);
        expect(legacySelections).toEqual([]);
        const manual = yield* resolve({
          dataProfile: Option.some("debug"),
          mode: Option.some("web"),
          host: Option.some("0.0.0.0"),
          port: Option.some(4999),
          httpsPort: Option.some(5001),
          noHttps: Option.some(false),
        });
        expect(manual.port).toBe(4999);
        expect(manual.httpsPort).toBe(5001);
        expect(manual.host).toBe("0.0.0.0");
        const production = yield* resolve({ dataProfile: Option.some("production") });
        expect(production.port).toBe(3773);
        expect(production.host).toBe("127.0.0.1");
        const legacy = yield* resolve({ mode: Option.some("web") });
        expect(legacy.port).toBe(3773);
        expect(legacy.host).toBeUndefined();
        expect(legacySelections).toEqual([3773]);
      }),
  );

  it.effect("keeps high-port Debug HTTPS fallback in its own range and distinct from HTTP", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-high-port-" });
      const probes: number[] = [];
      const net = Layer.succeed(NetService.NetService, {
        ...NetService.make(),
        canListenOnHost: (port) =>
          Effect.sync(() => {
            probes.push(port);
            return true;
          }),
        findAvailablePort: () =>
          Effect.die("Debug fallback must not select an OS ephemeral or release port"),
      });
      const result = yield* resolveServerConfig(
        flags({
          baseDir: Option.some(root),
          dataProfile: Option.some("debug"),
          port: Option.some(65535),
          noHttps: Option.some(false),
        }),
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), net),
        ),
      );
      expect(result.port).toBe(65535);
      expect(result.httpsPort).toBe(13775);
      expect(probes).toEqual([13775, 13775, 13775]);
    }),
  );

  it.effect(
    "keeps built/watch Debug and daemon paths identical while legacy standalone paths remain compatible",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-config-" });
        const built = yield* resolveServerConfig(
          flags({ baseDir: Option.some(root), dataProfile: Option.some("debug") }),
          Option.none(),
        ).pipe(Effect.provide(configured()));
        const watch = yield* resolveServerConfig(
          flags({
            baseDir: Option.some(root),
            dataProfile: Option.some("debug"),
            devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          }),
          Option.none(),
        ).pipe(Effect.provide(configured()));
        const daemon = yield* resolveProviderDaemonServerConfig({
          bootstrap: {
            mode: "provider-daemon",
            cafeCodeHome: path.join(root, ".debug"),
            configuredCafeCodeHome: root,
            dataProfile: "debug",
            token: "fixture-private-token-00000000000000000000",
          },
          logLevel: "Info",
          runtimeRole: "provider-daemon",
        });
        expect(built.baseDir).toBe(path.join(root, ".debug"));
        expect(built.configuredBaseDir).toBe(root);
        for (const key of [
          "stateDir",
          "dbPath",
          "settingsPath",
          "secretsDir",
          "worktreesDir",
          "providerStatusCacheDir",
        ] as const) {
          expect(watch[key]).toBe(built[key]);
          expect(daemon[key]).toBe(built[key]);
        }
        expect(built.dbPath).toBe(path.join(root, ".debug", "userdata", "state.sqlite"));
        const production = yield* resolveServerConfig(
          flags({ baseDir: Option.some(root), dataProfile: Option.some("production") }),
          Option.none(),
        ).pipe(Effect.provide(configured()));
        expect(production.dbPath).toBe(path.join(root, "userdata", "state.sqlite"));
        expect(yield* fs.exists(production.dbPath)).toBe(false);
        const legacy = yield* deriveServerPaths(root, new URL("http://127.0.0.1:5173"));
        expect(legacy.dbPath).toBe(path.join(root, "dev", "state.sqlite"));
      }),
  );

  const bootstrapFd = Effect.fn(function* (root: string, dataProfile: "production" | "debug") {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped({ prefix: "cafe-profile-bootstrap-" });
    const path = yield* Path.Path;
    const payload: Bootstrap = {
      mode: "desktop",
      noBrowser: true,
      port: 4888,
      cafeCodeHome: dataProfile === "debug" ? path.join(root, ".debug") : root,
      configuredCafeCodeHome: root,
      dataProfile,
      host: "127.0.0.1",
      desktopBootstrapToken: "fixture-private-token",
    };
    yield* fs.writeFileString(
      file,
      `${yield* Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap))(payload)}\n`,
    );
    if (process.platform === "win32") return openSync(file, "r");
    return (yield* fs.open(file, { flag: "r" })).fd;
  });

  it.effect("rejects ambient profile/root conflicts before creating either data profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-refuse-" });
      for (const env of [
        { CAFE_CODE_DATA_PROFILE: "production" },
        { CAFE_CODE_HOME: path.join(root, "other") },
      ]) {
        const fd = yield* bootstrapFd(root, "debug");
        const error = yield* resolveServerConfig(
          flags({ bootstrapFd: Option.some(fd) }),
          Option.none(),
        ).pipe(Effect.provide(configured(env)), Effect.flip);
        expect(error).toMatchObject({ _tag: "DataProfileSelectionError" });
        expect(yield* fs.exists(path.join(root, ".debug"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "userdata"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "other"))).toBe(false);
      }
    }),
  );

  it.effect("keeps a legacy private root authoritative without inventing profile proof", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-legacy-" });
      const effective = path.join(root, "legacy-effective");
      const openLegacy = Effect.fn(function* () {
        const file = yield* fs.makeTempFileScoped({ prefix: "cafe-profile-legacy-bootstrap-" });
        const payload: Bootstrap = {
          mode: "desktop",
          noBrowser: true,
          port: 4888,
          cafeCodeHome: effective,
          host: "127.0.0.1",
          desktopBootstrapToken: "fixture-private-token",
        };
        yield* fs.writeFileString(
          file,
          `${yield* Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap))(payload)}\n`,
        );
        return process.platform === "win32"
          ? openSync(file, "r")
          : (yield* fs.open(file, { flag: "r" })).fd;
      });
      for (const selection of [
        { env: { CAFE_CODE_DATA_PROFILE: "debug" }, options: {} },
        { env: { CAFE_CODE_DATA_PROFILE: "production" }, options: {} },
        { env: { CAFE_CODE_HOME: path.join(root, "other") }, options: {} },
        { env: {}, options: { dataProfile: Option.some("debug" as const) } },
        { env: {}, options: { baseDir: Option.some(path.join(root, "other")) } },
      ]) {
        const failure = yield* resolveServerConfig(
          flags({ ...selection.options, bootstrapFd: Option.some(yield* openLegacy()) }),
          Option.none(),
        ).pipe(Effect.provide(configured(selection.env)), Effect.flip);
        expect(failure).toMatchObject({ _tag: "DataProfileSelectionError" });
        expect(yield* fs.exists(effective)).toBe(false);
        expect(yield* fs.exists(path.join(root, "other"))).toBe(false);
      }
      const admitted = yield* resolveServerConfig(
        flags({ bootstrapFd: Option.some(yield* openLegacy()) }),
        Option.none(),
      ).pipe(Effect.provide(configured({ CAFE_CODE_HOME: effective })));
      expect(admitted.baseDir).toBe(effective);
      expect(admitted.dataProfile).toBeUndefined();
      expect(admitted.dbPath).toBe(path.join(effective, "userdata", "state.sqlite"));
      expect(yield* fs.exists(path.join(effective, ".debug"))).toBe(false);
    }),
  );

  it.effect(
    "carries the private parent's profile exactly once without borrowing ambient dev layout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-parent-" });
        const fd = yield* bootstrapFd(root, "debug");
        const result = yield* resolveServerConfig(
          flags({ bootstrapFd: Option.some(fd) }),
          Option.none(),
        ).pipe(Effect.provide(configured({ CAFE_CODE_DEV_URL: "http://127.0.0.1:5173" })));
        expect(result.dbPath).toBe(path.join(root, ".debug", "userdata", "state.sqlite"));
        expect(result.dataProfile).toBe("debug");
        expect(yield* fs.exists(path.join(root, ".debug", ".debug"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "userdata"))).toBe(false);
      }),
  );

  it.effect("rejects malformed bootstrap half-pairs in backend and daemon before profile IO", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-profile-half-pair-" });
      const effective = path.join(root, ".debug");
      for (const partial of [{ configuredCafeCodeHome: root }, { dataProfile: "debug" as const }]) {
        const payload: Bootstrap = {
          mode: "desktop",
          noBrowser: true,
          port: 4888,
          cafeCodeHome: effective,
          host: "127.0.0.1",
          desktopBootstrapToken: "fixture-private-token",
          ...partial,
        };
        const file = yield* fs.makeTempFileScoped({ prefix: "cafe-profile-malformed-" });
        yield* fs.writeFileString(
          file,
          `${yield* Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap))(payload)}\n`,
        );
        const fd =
          process.platform === "win32"
            ? openSync(file, "r")
            : (yield* fs.open(file, { flag: "r" })).fd;
        const failure = yield* resolveServerConfig(
          flags({ bootstrapFd: Option.some(fd) }),
          Option.none(),
        ).pipe(Effect.provide(configured()), Effect.flip);
        expect(failure).toMatchObject({ _tag: "DataProfileSelectionError" });
        const daemonFailure = yield* resolveProviderDaemonServerConfig({
          bootstrap: {
            mode: "provider-daemon",
            cafeCodeHome: effective,
            token: "fixture-private-token-00000000000000000000",
            ...partial,
          },
          logLevel: "Info",
          runtimeRole: "provider-daemon",
        }).pipe(Effect.flip);
        expect(daemonFailure).toMatchObject({ _tag: "ProviderDaemonCliError" });
        expect(yield* fs.exists(path.join(root, "userdata"))).toBe(false);
        expect(yield* fs.exists(effective)).toBe(false);
      }
    }),
  );
});
