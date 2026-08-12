import { readFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MANAGED_WINDOWS_NODE_VERSION,
  createBuildConfig,
  desktopArtifactListSatisfiesTarget,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopRuntimeDependencies,
  resolveDesktopUpdateChannel,
  resolveGitHubPublishConfig,
  resolveLinuxDesktopBuildConfig,
  resolveMacDesktopBuildConfig,
  resolveManagedWindowsNodeArchive,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  shouldStageWindowsManagedRuntime,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("always emits deterministic official updater metadata", () => {
    assert.deepStrictEqual(resolveGitHubPublishConfig("latest"), {
      provider: "github",
      owner: "cafeai",
      repo: "cafe-code",
      releaseType: "release",
    });
    assert.deepStrictEqual(resolveGitHubPublishConfig("nightly"), {
      provider: "github",
      owner: "cafeai",
      repo: "cafe-code",
      releaseType: "prerelease",
      channel: "nightly",
    });
  });

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

  it("stages managed runtimes only for Windows NSIS installers", () => {
    assert.equal(shouldStageWindowsManagedRuntime("win", "nsis"), true);
    assert.equal(shouldStageWindowsManagedRuntime("win", "nsis-web"), true);
    assert.equal(shouldStageWindowsManagedRuntime("win", "portable"), false);
    assert.equal(shouldStageWindowsManagedRuntime("mac", "dmg"), false);
    assert.equal(shouldStageWindowsManagedRuntime("linux", "AppImage"), false);
  });

  it("materializes catalog protocols before embedding the desktop package manifest", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          effect: "catalog:",
          "@effect/platform-node": "catalog:",
          "node-pty": "^1.1.0",
        },
        {
          effect: "4.0.0-beta.59",
          "@effect/platform-node": "4.0.0-beta.59",
        },
      ),
      {
        effect: "4.0.0-beta.59",
        "@effect/platform-node": "4.0.0-beta.59",
        "node-pty": "^1.1.0",
      },
    );
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

  it.effect("emits the macOS camera purpose string into packaged app metadata", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(resolveMacDesktopBuildConfig("dmg", true), {
        mac: {
          target: ["dmg", "zip"],
          icon: "icon.icns",
          category: "public.app-category.developer-tools",
          extendInfo: {
            NSCameraUsageDescription:
              "Cafe Code uses your camera only when you choose to capture a photo for a chat prompt.",
          },
          hardenedRuntime: true,
          entitlements: "apps/desktop/resources/entitlements.mac.plist",
          entitlementsInherit: "apps/desktop/resources/entitlements.mac.inherit.plist",
          entitlementsLoginHelper: "apps/desktop/resources/entitlements.mac.login-helper.plist",
        },
      });

      assert.deepStrictEqual(resolveMacDesktopBuildConfig("zip", false), {
        mac: {
          target: ["zip"],
          icon: "icon.icns",
          category: "public.app-category.developer-tools",
          extendInfo: {
            NSCameraUsageDescription:
              "Cafe Code uses your camera only when you choose to capture a photo for a chat prompt.",
          },
          identity: null,
          hardenedRuntime: false,
        },
      });

      const emittedConfig = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.17",
        true,
        false,
        undefined,
      );
      assert.deepStrictEqual((emittedConfig.mac as { readonly extendInfo: unknown }).extendInfo, {
        NSCameraUsageDescription:
          "Cafe Code uses your camera only when you choose to capture a photo for a chat prompt.",
      });
      assert.deepStrictEqual(emittedConfig.mac, resolveMacDesktopBuildConfig("dmg", true).mac);
      const buildResources = (emittedConfig.directories as { readonly buildResources: string })
        .buildResources;
      const mac = emittedConfig.mac as {
        readonly entitlements: string;
        readonly entitlementsInherit: string;
        readonly entitlementsLoginHelper: string;
      };
      for (const entitlementPath of [
        mac.entitlements,
        mac.entitlementsInherit,
        mac.entitlementsLoginHelper,
      ]) {
        assert.equal(entitlementPath.startsWith(`${buildResources}/`), true);
      }
    }),
  );

  it("keeps the signed macOS camera entitlement alongside Electron's helper baseline", () => {
    const requiredEntitlements = [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.camera",
    ];
    for (const resourceName of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
      const contents = readFileSync(
        new URL(`../apps/desktop/resources/${resourceName}`, import.meta.url),
        "utf8",
      );
      const enabledEntitlements = [...contents.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(
        ([, entitlement]) => entitlement,
      );
      assert.deepStrictEqual(enabledEntitlements, requiredEntitlements);
      assert.equal(contents.includes("<false/>"), false);
      assert.equal(contents.includes("com.apple.security.device.audio-input"), false);
      assert.equal(contents.includes("com.apple.security.device.microphone"), false);
    }

    const loginHelperContents = readFileSync(
      new URL("../apps/desktop/resources/entitlements.mac.login-helper.plist", import.meta.url),
      "utf8",
    );
    const loginHelperEntitlements = [
      ...loginHelperContents.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g),
    ].map(([, entitlement]) => entitlement);
    assert.deepStrictEqual(loginHelperEntitlements, requiredEntitlements.slice(0, 3));
    assert.equal(loginHelperContents.includes("com.apple.security.device.camera"), false);
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
