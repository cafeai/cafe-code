// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("keeps all active brand asset paths backed by files", async () => {
    await Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

      for (const assetPath of new Set(Object.values(BRAND_ASSET_PATHS))) {
        const absolutePath = path.join(repoRoot, assetPath);
        expect(yield* fileSystem.exists(absolutePath), assetPath).toBe(true);
        const stat = yield* fileSystem.stat(absolutePath);
        expect(stat.type, assetPath).toBe("File");
        expect(stat.size, assetPath).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
  });

  it("maps server publish web assets to production icons", () => {
    expect(PUBLISH_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps server build web assets to development icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("can target renderer web dist directly", () => {
    expect(resolveWebIconOverrides("production", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });
});
