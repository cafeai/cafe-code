// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import os from "node:os";
import path from "node:path";
import { ProviderDriverKind } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { CLAUDE_PROVIDER_MAINTENANCE } from "./claudeMaintenance.ts";
import {
  clearLatestProviderVersionCacheForTests,
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

function createSymlinkOrSkipOnWindowsPrivilegeError(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return false;
    }
    throw error;
  }
}

const driver = (value: string) => ProviderDriverKind.make(value);
const makeTempDir = Effect.fn("makeTempDir")(function* (name: string) {
  const id = yield* Random.nextUUIDv4;
  return path.join(os.tmpdir(), `${name}-${id}`);
});
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  homebrewFormula: "package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  homebrewFormula: "native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const scopedPackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("scopedPackageTool"),
  npmPackageName: "@example/scoped-package-tool",
  homebrewFormula: "example/tap/scoped-package-tool",
  nativeUpdate: {
    executable: "scoped-package-tool",
    args: ["upgrade"],
    lockKey: "scoped-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.scoped-package-tool/bin/scoped-package-tool"),
  },
});
const staticToolUpdate = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: driver("staticTool"),
    packageName: null,
    updateExecutable: "static-tool",
    updateArgs: ["update"],
    updateLockKey: "static-tool",
  }),
);

afterEach(() => {
  clearLatestProviderVersionCacheForTests();
});

describe("providerMaintenance", () => {
  const claudeUpdate = makePackageManagedProviderMaintenanceResolver(CLAUDE_PROVIDER_MAINTENANCE);
  const syntheticAlias = "/cafe-maintenance-synthetic-fixture/bin/claude";
  const options = { binaryPath: syntheticAlias, platform: "darwin" as const, env: { PATH: "" } };
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    for (const cask of ["claude-code", "claude-code@latest"] as const) {
      it("selects the exact observed " + cask + " cask under " + prefix, () => {
        const capabilities = claudeUpdate.resolve({
          ...options,
          realCommandPath: prefix + "/Caskroom/" + cask + "/2.1.314/claude",
        });
        expect(capabilities.update).toEqual({
          command: "brew upgrade " + cask,
          executable: "brew",
          args: ["upgrade", cask],
          lockKey: "homebrew",
        });
      });
    }
  }
  it.effect("uses only the successful native realPath observation to select Claude latest", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const nativeLookingAlias = "/cafe-synthetic/.local/bin/claude";
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
        ...options,
        binaryPath: nativeLookingAlias,
      });
      expect(calls).toEqual([nativeLookingAlias]);
      expect(capabilities.update?.args).toEqual(["upgrade", "claude-code@latest"]);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          realPath: (value) => {
            calls.push(value);
            return Effect.succeed("/opt/homebrew/Caskroom/claude-code@latest/2.1.314/claude");
          },
        }),
      ),
    );
  });
  it.effect("never upgrades a lexical Caskroom guess after native realPath failure", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(claudeUpdate, {
        ...options,
        binaryPath: "/opt/homebrew/Caskroom/claude-code@latest/cafe-fixture-version/claude",
      });
      expect(capabilities.update).toBeNull();
    }).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({}))),
  );
  it.effect(
    "scrubs a hidden caller realPath value when the actual filesystem observation fails",
    () =>
      Effect.gen(function* () {
        const hidden = {
          ...options,
          realCommandPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/claude",
        };
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          claudeUpdate,
          hidden,
        );
        expect(capabilities.update).toBeNull();
      }).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({}))),
  );
  it.effect("preserves a generic provider's legacy Homebrew outcome after realPath failure", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: "/opt/homebrew/bin/cafe-package-tool-synthetic-fixture",
        platform: "darwin",
        env: { PATH: "" },
      });
      expect(capabilities.update?.args).toEqual(["upgrade", "package-tool"]);
    }).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({}))),
  );
  for (const realCommandPath of [
    undefined,
    null,
    "/opt/homebrew/bin/claude",
    "/opt/homebrew/Caskroom/claude-code@beta/2.1.314/claude",
    "/custom/Homebrew/Caskroom/claude-code@latest/2.1.314/claude",
    "/tmp/opt/homebrew/Caskroom/claude-code@latest/2.1.314/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/./claude",
    "/opt/homebrew/Caskroom/claude-code@latest/../claude",
    "/opt/homebrew/Caskroom/claude-code@latest/--force/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/extra/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/not-claude",
    "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/--force",
    "/opt/homebrew/Caskroom/claude-code@latest --force/2.1.314/claude",
    "/opt/homebrew/Caskroom/claude-code@latest;touch-owned/2.1.314/claude",
    "/opt/homebrew/Caskroom/claude-code@latest%2Fother/2.1.314/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/" + "1".repeat(129) + "/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/claude\u0000ignored",
    "/opt/homebrew/Caskroom/CLAUDE-CODE@LATEST/2.1.314/claude",
    "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/Claude",
    "/opt/homebrew/caskroom/claude-code@latest/2.1.314/claude",
    "file:///opt/homebrew/Caskroom/claude-code@latest/2.1.314/claude",
  ]) {
    it(
      "refuses unproved, malformed or non-allowlisted Claude cask evidence " +
        String(realCommandPath),
      () => {
        expect(claudeUpdate.resolve({ ...options, realCommandPath }).update).toBeNull();
      },
    );
  }
  it("preserves manual-only policy for an empty legacy formula", () => {
    const empty = makePackageManagedProviderMaintenanceResolver({
      provider: driver("packageTool"),
      npmPackageName: "@example/package-tool",
      homebrewFormula: "",
      nativeUpdate: null,
    });
    expect(
      empty.resolve({
        ...options,
        binaryPath: "/opt/homebrew/bin/cafe-package-tool-synthetic-fixture",
      }).update,
    ).toBeNull();
  });
  it("does not infer a Claude channel from a Homebrew bin alias alone", () => {
    expect(
      claudeUpdate.resolve({
        ...options,
        binaryPath: "/opt/homebrew/bin/cafe-claude-synthetic-fixture",
      }).update,
    ).toBeNull();
  });
  it("does not adopt a macOS cask target on another platform", () => {
    expect(
      claudeUpdate.resolve({
        ...options,
        platform: "linux",
        realCommandPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/claude",
      }).update,
    ).toBeNull();
  });
  for (const row of [
    {
      binaryPath: "/cafe-synthetic/.local/bin/claude",
      executable: "claude",
      args: ["update"],
      lockKey: "claude-native",
    },
    {
      binaryPath: "/cafe-synthetic/.vite-plus/bin/claude",
      executable: "vp",
      args: ["i", "-g", "@anthropic-ai/claude-code"],
      lockKey: "vite-plus-global",
    },
    {
      binaryPath: "/cafe-synthetic/.local/share/pnpm/claude",
      executable: "pnpm",
      args: ["add", "-g", "@anthropic-ai/claude-code@latest"],
      lockKey: "pnpm-global",
    },
    {
      binaryPath: "/cafe-synthetic/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      executable: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code@latest"],
      lockKey: "npm-global",
    },
  ]) {
    it("preserves " + row.lockKey + " behavior for a non-Caskroom installation", () => {
      const update = claudeUpdate.resolve({
        ...options,
        binaryPath: row.binaryPath,
        realCommandPath: row.binaryPath,
      }).update;
      expect(update).toMatchObject({
        executable: row.executable,
        args: row.args,
        lockKey: row.lockKey,
      });
    });
  }

  for (const binaryPath of [
    "/cafe-synthetic/.local/bin/claude",
    "/cafe-synthetic/.vite-plus/bin/claude",
    "/cafe-synthetic/.local/share/pnpm/claude",
    "/cafe-synthetic/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
  ]) {
    for (const cask of ["claude-code", "claude-code@latest"] as const) {
      it("uses observed " + cask + " ownership instead of lexical alias " + binaryPath, () => {
        const update = claudeUpdate.resolve({
          ...options,
          binaryPath,
          realCommandPath: "/opt/homebrew/Caskroom/" + cask + "/2.1.314/claude",
        }).update;
        expect(update).toEqual({
          command: "brew upgrade " + cask,
          executable: "brew",
          args: ["upgrade", cask],
          lockKey: "homebrew",
        });
      });
    }
    for (const realCommandPath of [
      "/opt/homebrew/Caskroom",
      "/opt/homebrew/Caskroom/claude-code@beta/2.1.314/claude",
      "/opt/homebrew/Caskroom/claude-code@latest/../claude",
      "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/extra/claude",
      "/opt/homebrew/Caskroom/claude-code@latest/2.1.314/not-claude",
      "/opt/homebrew/Caskroom/--force/2.1.314/claude",
    ]) {
      it(
        "does not fall through another updater for invalid known Caskroom ownership " +
          binaryPath +
          realCommandPath,
        () => {
          expect(
            claudeUpdate.resolve({ ...options, binaryPath, realCommandPath }).update,
          ).toBeNull();
        },
      );
    }
  }
  it.effect(
    "bounds version lookup across headers and a stalled body without changing cache expiry",
    () => {
      let requestCount = 0;
      let finishBody: (() => void) | undefined;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requestCount += 1;
          if (requestCount === 1) {
            // Consume half the total deadline before headers arrive, then emit
            // valid but incomplete JSON. A headers-only or per-phase deadline
            // would leave the lookup running beyond the four-second budget.
            yield* Effect.sleep("2 seconds");
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"version":'));
                    finishBody = () => controller.close();
                  },
                }),
              ),
            );
          }
          return HttpClientResponse.fromWeb(request, Response.json({ version: "1.2.3" }));
        }),
      );
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => finishBody?.()));
        const capabilities = makeProviderMaintenanceCapabilities({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          updateExecutable: null,
          updateArgs: [],
          updateLockKey: null,
        });
        const lookup = yield* resolveLatestProviderVersion(capabilities).pipe(Effect.forkChild);

        yield* TestClock.adjust("3999 millis");
        expect(lookup.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        expect(yield* Fiber.join(lookup)).toBeNull();

        // Timeout remains a cached unknown result, so a UI refresh does not
        // immediately repeat the stalled request. The normal TTL still expires.
        expect(yield* resolveLatestProviderVersion(capabilities)).toBeNull();
        expect(requestCount).toBe(1);
        yield* TestClock.adjust("1 hour");
        expect(yield* resolveLatestProviderVersion(capabilities)).toBe("1.2.3");
        expect(yield* resolveLatestProviderVersion(capabilities)).toBe("1.2.3");
        expect(requestCount).toBe(2);
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    },
  );

  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("marks installed providers behind latest when a newer provider version is available", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: nativePackageToolUpdate.resolve({
          binaryPath:
            "/usr/local/lib/node_modules/@example/native-package-tool/bin/native-package-tool.js",
          platform: "linux",
          env: { PATH: "" },
        }),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand: "npm install -g @example/native-package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("keeps update commands owned by provider maintenance capabilities", () => {
    expect(staticToolUpdate.resolve()).toEqual({
      provider: driver("staticTool"),
      packageName: null,
      update: {
        command: "static-tool update",

        executable: "static-tool",

        args: ["update"],

        lockKey: "static-tool",
      },
    });
  });

  it.effect(
    "switches package-managed providers to vite-plus updates when the resolved binary lives in vite-plus global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-vite-plus-capabilities");
        const vitePlusBinDir = path.join(tempDir, ".vite-plus", "bin");
        mkdirSync(vitePlusBinDir, { recursive: true });
        const packageToolPath = path.join(vitePlusBinDir, "package-tool");
        writeFileSync(packageToolPath, "#!/bin/sh\n");
        chmodSync(packageToolPath, 0o755);

        expect(
          packageToolUpdate.resolve({
            // The resolver receives the already-resolved executable in
            // production. Pass that host-native path directly so this Darwin
            // policy test does not ask a Windows runner to interpret a
            // Windows PATH with POSIX delimiter semantics.
            binaryPath: packageToolPath,
            platform: "darwin",
            env: { PATH: "" },
          }),
        ).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: "vp i -g @example/package-tool",

            executable: "vp",

            args: ["i", "-g", "@example/package-tool"],

            lockKey: "vite-plus-global",
          },
        });
      }),
  );

  it("disables one-click updates for project-local Yarn binaries", () => {
    expect(
      nativePackageToolUpdate.resolve({
        binaryPath: "/workspace/.yarn/unplugged/native-package-tool/bin/native-package-tool.js",
        platform: "linux",
        env: { PATH: "" },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: null,
    });
  });

  it("uses a Windows command shim for npm-managed provider updates on Windows", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\package-tool.cmd",
        platform: "win32",
        env: {
          APPDATA: "C:\\Users\\me\\AppData\\Roaming",
          PATH: "",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: {
        command: "npm.cmd install -g @example/package-tool@latest",

        executable: "npm.cmd",

        args: ["install", "-g", "@example/package-tool@latest"],

        lockKey: "npm-global",
      },
    });
  });

  it("does not guess an updater when a package executable cannot be resolved", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "package-tool",
        platform: "linux",
        env: { PATH: "" },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: null,
    });
  });

  it.effect(
    "switches package-managed providers to pnpm updates when the resolved binary lives in pnpm's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const pnpmHomeDir = path.join(tempDir, ".local", "share", "pnpm");
        mkdirSync(pnpmHomeDir, { recursive: true });
        const scopedPackageToolPath = path.join(pnpmHomeDir, "scoped-package-tool");
        writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        chmodSync(scopedPackageToolPath, 0o755);

        expect(
          scopedPackageToolUpdate.resolve({
            binaryPath: scopedPackageToolPath,
            platform: "darwin",
            env: { PATH: "" },
          }),
        ).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "pnpm add -g @example/scoped-package-tool@latest",

            executable: "pnpm",

            args: ["add", "-g", "@example/scoped-package-tool@latest"],

            lockKey: "pnpm-global",
          },
        });
      }),
  );

  it("switches package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: {
        command: "brew upgrade package-tool",

        executable: "brew",

        args: ["upgrade", "package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it.effect(
    "switches native-package-tool to native updates when the binary resolves through the native installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-package-tool-native-capabilities");
        const nativeBinDir = path.join(tempDir, ".local", "bin");
        mkdirSync(nativeBinDir, { recursive: true });
        const nativePackageToolPath = path.join(nativeBinDir, "native-package-tool");
        writeFileSync(nativePackageToolPath, "#!/bin/sh\n");
        chmodSync(nativePackageToolPath, 0o755);

        expect(
          nativePackageToolUpdate.resolve({
            binaryPath: nativePackageToolPath,
            platform: "darwin",
            env: { PATH: "" },
          }),
        ).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "native-package-tool update",

            executable: "native-package-tool",

            args: ["update"],

            lockKey: "native-package-tool-native",
          },
        });
      }),
  );

  it.effect(
    "switches scoped-package-tool to native upgrades when the binary resolves through the standalone installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-scoped-package-tool-native-capabilities");
        const nativeBinDir = path.join(tempDir, ".scoped-package-tool", "bin");
        mkdirSync(nativeBinDir, { recursive: true });
        const scopedPackageToolPath = path.join(nativeBinDir, "scoped-package-tool");
        writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        chmodSync(scopedPackageToolPath, 0o755);

        expect(
          scopedPackageToolUpdate.resolve({
            binaryPath: scopedPackageToolPath,
            platform: "darwin",
            env: { PATH: "" },
          }),
        ).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "scoped-package-tool upgrade",

            executable: "scoped-package-tool",

            args: ["upgrade"],

            lockKey: "scoped-package-tool-native",
          },
        });
      }),
  );

  it("switches native-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      nativePackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/native-package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: {
        command: "brew upgrade native-package-tool",

        executable: "brew",

        args: ["upgrade", "native-package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it("switches scoped-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      scopedPackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/scoped-package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("scopedPackageTool"),
      packageName: "@example/scoped-package-tool",
      update: {
        command: "brew upgrade example/tap/scoped-package-tool",

        executable: "brew",

        args: ["upgrade", "example/tap/scoped-package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it.effect("keeps npm updates for binaries symlinked into npm's global node_modules tree", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-capabilities");
      const binDir = path.join(tempDir, "bin");
      const packageBinDir = path.join(
        tempDir,
        "lib",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      mkdirSync(binDir, { recursive: true });
      mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = path.join(packageBinDir, "package-tool.js");
      const symlinkPath = path.join(binDir, "package-tool");
      writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      chmodSync(packageBinPath, 0o755);
      if (!createSymlinkOrSkipOnWindowsPrivilegeError(packageBinPath, symlinkPath)) {
        return;
      }

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        platform: "darwin",
        env: {
          PATH: "",
        },
      }).pipe(Effect.provide(NodeServices.layer));

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "npm install -g @example/package-tool@latest",

          executable: "npm",

          args: ["install", "-g", "@example/package-tool@latest"],

          lockKey: "npm-global",
        },
      });
    }),
  );

  it.effect("uses Effect FileSystem realPath when detecting pnpm global symlinks", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-pnpm-realpath-capabilities");
      const binDir = path.join(tempDir, "bin");
      const packageBinDir = path.join(
        tempDir,
        ".local",
        "share",
        "pnpm",
        "global",
        "5",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      mkdirSync(binDir, { recursive: true });
      mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = path.join(packageBinDir, "package-tool.js");
      const symlinkPath = path.join(binDir, "package-tool");
      writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      chmodSync(packageBinPath, 0o755);
      if (!createSymlinkOrSkipOnWindowsPrivilegeError(packageBinPath, symlinkPath)) {
        return;
      }

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        platform: "darwin",
        env: {
          PATH: "",
        },
      }).pipe(Effect.provide(NodeServices.layer));

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "pnpm add -g @example/package-tool@latest",

          executable: "pnpm",

          args: ["add", "-g", "@example/package-tool@latest"],

          lockKey: "pnpm-global",
        },
      });
    }),
  );

  it("disables one-click updates for explicit custom binary paths it cannot safely map", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "C:\\Tools\\package-tool\\package-tool.exe",
        platform: "win32",
        env: {
          PATH: "",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: null,
    });
  });
});
