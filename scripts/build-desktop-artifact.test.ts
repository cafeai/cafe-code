import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  MANAGED_WINDOWS_NODE_VERSION,
  desktopArtifactListSatisfiesTarget,
  extractManagedWindowsNodeArchive,
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
import { REPOSITORY_NODE_VERSION } from "./lib/node-version.ts";

// The extractor is replaced at the process service boundary. These fixtures
// exercise the production byte verification, private snapshot, resource scope
// and staging reads without downloading an archive or launching any process.
function extractionPaths(
  command: ChildProcess.Command,
  platform: NodeJS.Platform = process.platform,
) {
  if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected one extraction command.");
  if (platform !== "win32") {
    assert.equal(command.command, "unzip");
    assert.equal(command.args[0], "-q");
    assert.equal(command.args[2], "-d");
    return { archivePath: command.args[1]!, destination: command.args[3]! };
  }
  assert.equal(command.command, "powershell.exe");
  assert.deepEqual(command.args.slice(0, 4), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.lengthOf(command.args, 5);
  const invocation = command.args[4]!;
  // This fixture admits precisely the production invocation, not PowerShell
  // syntax in general. A word boundary before '-LiteralPath' is impossible
  // after the preceding space: both the space and '-' are non-word characters.
  // An anchored command prefix validates it directly and stays fail-closed.
  const literals =
    /^Expand-Archive -LiteralPath '((?:[^']|'')*)' -DestinationPath '((?:[^']|'')*)' -Force$/u.exec(
      invocation,
    );
  assert.isNotNull(literals);
  assert.equal(literals![0], invocation);
  return {
    archivePath: literals![1]!.replaceAll("''", "'"),
    destination: literals![2]!.replaceAll("''", "'"),
  };
}

function completedExtractionHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("parses the Windows extraction fixture on every host with exact structured arguments and literal quoted paths", () => {
    const archivePath = "C:\\cache with spaces and ' quotes\\verified-extract-123\\node.zip";
    const destination = "C:\\cache with spaces and ' quotes\\verified-extract-123";
    const invocation = `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`;
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", invocation];
    assert.deepEqual(extractionPaths(ChildProcess.make("powershell.exe", args), "win32"), {
      archivePath,
      destination,
    });
    // These assertions run on macOS/Linux too; no native command or platform
    // mutation is needed to catch regressions in the Windows fixture branch.
    assert.throws(() => extractionPaths(ChildProcess.make("other.exe", args), "win32"));
    assert.throws(() =>
      extractionPaths(ChildProcess.make("powershell.exe", args.slice(1)), "win32"),
    );
    assert.throws(() =>
      extractionPaths(ChildProcess.make("powershell.exe", [...args, "extra"]), "win32"),
    );
    for (const invalidInvocation of [
      invocation.replace("Expand-Archive ", ""),
      `${invocation}; unexpected-command`,
      `${invocation}\n`,
      invocation.replace("-LiteralPath '", "-LiteralPath "),
      invocation.replace("-DestinationPath", "-OtherOption"),
      invocation.replace(" -Force", ""),
    ]) {
      assert.throws(() =>
        extractionPaths(
          ChildProcess.make("powershell.exe", [...args.slice(0, 4), invalidInvocation]),
          "win32",
        ),
      );
    }
  });

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

  it("declares why packaged macOS builds request microphone and local network access", () => {
    assert.deepStrictEqual(resolveMacDesktopBuildConfig("dmg", false), {
      extraResources: [
        {
          from: "apps/desktop/resources/mac-dictation-target",
          to: "mac-dictation-target",
        },
      ],
      mac: {
        target: ["dmg", "zip"],
        icon: "icon.icns",
        category: "public.app-category.developer-tools",
        extendInfo: {
          NSMicrophoneUsageDescription:
            "Cafe Code uses microphone audio only when you start dictation.",
          NSLocalNetworkUsageDescription:
            "Cafe Code connects to Cafe servers you select on your local network.",
        },
        identity: null,
        hardenedRuntime: false,
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
    assert.equal(MANAGED_WINDOWS_NODE_VERSION, REPOSITORY_NODE_VERSION);
    assert.deepStrictEqual(resolveManagedWindowsNodeArchive("x64"), {
      arch: "x64",
      fileName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-x64.zip`,
      sourceDirectoryName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-x64`,
      sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
      url: `https://nodejs.org/dist/v${MANAGED_WINDOWS_NODE_VERSION}/node-v${MANAGED_WINDOWS_NODE_VERSION}-win-x64.zip`,
    });
    assert.deepStrictEqual(resolveManagedWindowsNodeArchive("arm64"), {
      arch: "arm64",
      fileName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-arm64.zip`,
      sourceDirectoryName: `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-arm64`,
      sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
      url: `https://nodejs.org/dist/v${MANAGED_WINDOWS_NODE_VERSION}/node-v${MANAGED_WINDOWS_NODE_VERSION}-win-arm64.zip`,
    });
    assert.equal(resolveManagedWindowsNodeArchive("universal"), null);
    // A future canonical pin needs a newly reviewed archive tuple; constructing
    // a new download URL while silently keeping an old hash cannot pass.
    assert.throws(
      () => resolveManagedWindowsNodeArchive("x64", "999.0.0"),
      /no reviewed Windows archive hashes/,
    );
    assert.throws(() => resolveManagedWindowsNodeArchive("x64", "lts/*"), /one exact stable Node/);
  });

  it.effect(
    "stages a fresh verified extraction without trusting or deleting the old extracted cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-managed-node-" });
        const cacheDir = path.join(fixtureRoot, "cache with spaces and ' quotes");
        const verifiedBytes = new TextEncoder().encode("synthetic verified archive contents");
        const archive = {
          ...resolveManagedWindowsNodeArchive("x64")!,
          sha256: createHash("sha256").update(verifiedBytes).digest("hex"),
        };
        const archivePath = path.join(cacheDir, archive.fileName);
        const oldExtractedRoot = path.join(cacheDir, archive.sourceDirectoryName);
        yield* fs.makeDirectory(oldExtractedRoot, { recursive: true });
        yield* fs.writeFile(archivePath, verifiedBytes);
        yield* fs.writeFileString(
          path.join(oldExtractedRoot, "node.exe"),
          "modified cached executable",
        );
        yield* fs.writeFileString(path.join(oldExtractedRoot, "npm.cmd"), "modified cached shim");
        const stagedRoot = path.join(fixtureRoot, "stage");
        let extractCount = 0;
        let privateRoot: string | undefined;
        const extractor = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            extractCount += 1;
            const invocation = extractionPaths(command);
            privateRoot = invocation.destination;
            assert.equal(path.dirname(privateRoot), cacheDir);
            assert.notEqual(privateRoot, cacheDir);
            assert.equal(path.dirname(invocation.archivePath), privateRoot);
            // Replacing the shared ZIP after admission cannot change the bytes
            // handed to the extractor: it receives only the private snapshot.
            yield* fs.writeFileString(archivePath, "concurrent shared cache replacement");
            assert.deepEqual(yield* fs.readFile(invocation.archivePath), verifiedBytes);
            const extractedRoot = path.join(privateRoot, archive.sourceDirectoryName);
            yield* fs.makeDirectory(extractedRoot, { recursive: true });
            yield* fs.writeFileString(path.join(extractedRoot, "node.exe"), "verified executable");
            yield* fs.writeFileString(path.join(extractedRoot, "npm.cmd"), "verified shim");
            yield* fs.writeFileString(
              path.join(extractedRoot, "runtime-extra.txt"),
              "verified extra file",
            );
            return completedExtractionHandle();
          }),
        );
        const extractedRoot = yield* Effect.scoped(
          Effect.gen(function* () {
            const freshRoot = yield* extractManagedWindowsNodeArchive(
              archive,
              archivePath,
              cacheDir,
              false,
            );
            assert.notEqual(freshRoot, oldExtractedRoot);
            yield* fs.copy(freshRoot, stagedRoot);
            return freshRoot;
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, extractor)),
        );
        assert.equal(extractCount, 1);
        assert.equal(yield* fs.exists(extractedRoot), false);
        assert.equal(yield* fs.exists(privateRoot!), false);
        assert.equal(
          yield* fs.readFileString(path.join(stagedRoot, "node.exe")),
          "verified executable",
        );
        assert.equal(
          yield* fs.readFileString(path.join(stagedRoot, "runtime-extra.txt")),
          "verified extra file",
        );
        assert.equal(
          yield* fs.readFileString(path.join(oldExtractedRoot, "node.exe")),
          "modified cached executable",
        );
        assert.equal(
          yield* fs.readFileString(path.join(oldExtractedRoot, "npm.cmd")),
          "modified cached shim",
        );
      }),
  );

  it.effect("rejects a replaced ZIP before the extractor can stage any files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped({
        prefix: "cafecode-managed-node-mismatch-",
      });
      const archive = resolveManagedWindowsNodeArchive("x64")!;
      const archivePath = path.join(cacheDir, archive.fileName);
      yield* fs.writeFileString(archivePath, "unverified ZIP");
      let extractCount = 0;
      const extractor = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          extractCount += 1;
          return completedExtractionHandle();
        }),
      );
      const error = yield* extractManagedWindowsNodeArchive(
        archive,
        archivePath,
        cacheDir,
        false,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, extractor),
        Effect.scoped,
        Effect.flip,
      );
      assert.equal(error._tag, "BuildScriptError");
      assert.match(error.message, /hash mismatch before extraction/);
      assert.equal(extractCount, 0);
      assert.deepEqual(yield* fs.readDirectory(cacheDir), [archive.fileName]);
    }),
  );

  it.effect(
    "cleans the scoped extraction when a verified archive omits its expected runtime files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fs.makeTempDirectoryScoped({
          prefix: "cafecode-managed-node-incomplete-",
        });
        const bytes = new TextEncoder().encode("synthetic incomplete archive");
        const archive = {
          ...resolveManagedWindowsNodeArchive("x64")!,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        const archivePath = path.join(cacheDir, archive.fileName);
        yield* fs.writeFile(archivePath, bytes);
        let privateRoot: string | undefined;
        const extractor = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            privateRoot = extractionPaths(command).destination;
            return completedExtractionHandle();
          }),
        );
        const error = yield* extractManagedWindowsNodeArchive(
          archive,
          archivePath,
          cacheDir,
          false,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, extractor),
          Effect.scoped,
          Effect.flip,
        );
        assert.equal(error._tag, "BuildScriptError");
        assert.match(error.message, /did not extract node.exe\/npm.cmd/);
        assert.equal(yield* fs.exists(privateRoot!), false);
        assert.equal(yield* fs.exists(archivePath), true);
      }),
  );

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
