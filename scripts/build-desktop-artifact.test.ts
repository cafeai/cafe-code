import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MANAGED_WINDOWS_NODE_VERSION,
  desktopArtifactListSatisfiesTarget,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveLinuxDesktopBuildConfig,
  resolveManagedWindowsNodeArchive,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  shouldStageWindowsManagedRuntime,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Cafe Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Cafe Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@cafecode/contracts": "workspace:*",
          "@cafecode/shared": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("stages managed runtimes only for Windows NSIS installers", () => {
    assert.equal(shouldStageWindowsManagedRuntime("win", "nsis"), true);
    assert.equal(shouldStageWindowsManagedRuntime("win", "nsis-web"), true);
    assert.equal(shouldStageWindowsManagedRuntime("win", "portable"), false);
    assert.equal(shouldStageWindowsManagedRuntime("mac", "dmg"), false);
    assert.equal(shouldStageWindowsManagedRuntime("linux", "AppImage"), false);
  });

  it("requires a Windows NSIS exe artifact instead of accepting intermediate files", () => {
    assert.equal(
      desktopArtifactListSatisfiesTarget("win", "nsis", [
        "release/builder-debug.yml",
        "release/cafe-code-0.0.51-x64.nsis.7z",
      ]),
      false,
    );
    assert.equal(
      desktopArtifactListSatisfiesTarget("win", "nsis", [
        "release/Cafe-Code-0.0.51-x64.exe",
        "release/cafe-code-0.0.51-x64.nsis.7z",
      ]),
      true,
    );
    assert.equal(desktopArtifactListSatisfiesTarget("mac", "dmg", ["release/Cafe.dmg"]), true);
  });

  it("configures Debian package identity and metadata explicitly", () => {
    assert.deepStrictEqual(resolveLinuxDesktopBuildConfig("deb"), {
      linux: {
        target: ["deb"],
        executableName: "cafe-code",
        icon: "icon.png",
        category: "Development",
        synopsis: "Desktop GUI for coding agents",
        description:
          "Cafe Code is a desktop GUI for coding agents such as Codex, Claude, and OpenCode.",
        maintainer: "CafeAI <116491182+cafeai@users.noreply.github.com>",
        vendor: "CafeAI",
        desktop: {
          entry: {
            StartupWMClass: "cafe-code",
          },
        },
      },
      deb: {
        packageName: "cafe-code",
        packageCategory: "devel",
        priority: "optional",
        depends: [
          "libgtk-3-0",
          "libnotify4",
          "libnss3",
          "libxss1",
          "libxtst6",
          "xdg-utils",
          "libatspi2.0-0",
          "libuuid1",
          "libsecret-1-0",
          "libgbm1",
          "openssl",
          "libasound2t64 | libasound2",
        ],
        recommends: [],
      },
    });
  });

  it("requires a Debian artifact instead of accepting builder metadata alone", () => {
    assert.equal(
      desktopArtifactListSatisfiesTarget("linux", "deb", ["release/builder-debug.yml"]),
      false,
    );
    assert.equal(
      desktopArtifactListSatisfiesTarget("linux", "deb", [
        "release/builder-debug.yml",
        "release/Cafe-Code-0.0.51-amd64.deb",
      ]),
      true,
    );
  });

  it("pins Windows managed Node archives by version, arch, and hash", () => {
    assert.deepStrictEqual(resolveManagedWindowsNodeArchive("x64"), {
      arch: "x64",
      fileName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-x64.zip`,
      sourceDirectoryName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-x64`,
      sha256: "fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279",
      url: `https://nodejs.org/dist/v${MANAGED_WINDOWS_NODE_VERSION}/node-v${MANAGED_WINDOWS_NODE_VERSION}-win-x64.zip`,
    });
    assert.deepStrictEqual(resolveManagedWindowsNodeArchive("arm64"), {
      arch: "arm64",
      fileName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-arm64.zip`,
      sourceDirectoryName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-arm64`,
      sha256: "0cd29eeb64f3c649db2c4c868779ca277f5a4c49e26c69e5928d01fe0ae06da8",
      url: `https://nodejs.org/dist/v${MANAGED_WINDOWS_NODE_VERSION}/node-v${MANAGED_WINDOWS_NODE_VERSION}-win-arm64.zip`,
    });
    assert.equal(resolveManagedWindowsNodeArchive("universal"), null);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                CAFE_CODE_DESKTOP_SKIP_BUILD: "true",
                CAFE_CODE_DESKTOP_KEEP_STAGE: "true",
                CAFE_CODE_DESKTOP_SIGNED: "true",
                CAFE_CODE_DESKTOP_VERBOSE: "true",
                CAFE_CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
