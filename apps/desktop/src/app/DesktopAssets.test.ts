import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const resolvePng = (input: {
  platform: NodeJS.Platform;
  development?: boolean;
  macResource?: boolean;
  developmentAsset?: boolean;
  packaged?: boolean;
}) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = environment.path;
    const resource = input.packaged
      ? path.join(environment.resourcesPath, "resources")
      : path.join(environment.rootDir, "apps/desktop/resources");
    const available = new Set([path.join(resource, "icon.png")]);
    if (input.macResource) available.add(path.join(resource, "icon-macos.png"));
    if (input.developmentAsset) available.add(environment.developmentDockIconPath);
    const assets = yield* Effect.gen(function* () {
      return yield* DesktopAssets.DesktopAssets;
    }).pipe(
      Effect.provide(DesktopAssets.layer),
      Effect.provide(
        FileSystem.layerNoop({ exists: (file) => Effect.succeed(available.has(file)) }),
      ),
    );
    return { png: (yield* assets.iconPaths).png, resource, environment };
  }).pipe(
    Effect.provide(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/fixture-home",
        platform: input.platform,
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/fixture-app",
        isPackaged: input.packaged ?? false,
        resourcesPath: "/fixture-resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          DesktopConfig.layerTest({ CAFE_CODE_DESKTOP_DEV: input.development ? "true" : "false" }),
        ),
      ),
    ),
  );

describe("DesktopAssets Dock PNG selection", () => {
  it.effect("uses the inset Mac resource for ordinary source launches", () =>
    Effect.gen(function* () {
      const { png, resource, environment } = yield* resolvePng({
        platform: "darwin",
        macResource: true,
      });
      assert.deepEqual(png, Option.some(environment.path.join(resource, "icon-macos.png")));
    }),
  );
  it.effect("uses the Mac development asset when the dedicated resource is unavailable", () =>
    Effect.gen(function* () {
      const { png, environment } = yield* resolvePng({
        platform: "darwin",
        development: true,
        developmentAsset: true,
      });
      assert.deepEqual(png, Option.some(environment.developmentDockIconPath));
    }),
  );
  it.effect("retains icon.png for packaged resources and non-Mac hosts", () =>
    Effect.gen(function* () {
      for (const platform of ["darwin", "win32", "linux"] as const) {
        const { png, resource, environment } = yield* resolvePng({
          platform,
          macResource: platform !== "darwin",
          packaged: platform === "darwin",
        });
        assert.deepEqual(png, Option.some(environment.path.join(resource, "icon.png")));
      }
    }),
  );
});
