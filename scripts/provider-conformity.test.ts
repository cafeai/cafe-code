import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  detectInstallKind,
  assertRecoveryProjectOutsideRepo,
  buildProviderInvocation,
  createUpdatePlan,
  normalizeGitHubRepository,
  parseProviderConformityArgs,
  parseManifest,
  launchCommand,
  killallProvedComplete,
  providerUpdateCommand,
  resolveCorepackCommand,
  resolveNpmCommand,
  resolvePathCommand,
  resolveWindowsPowerShell,
  runCommand,
  selectRecoveryProjectDirectory,
  validateSourcePins,
  validateGitHubRepositoryName,
} from "./provider-conformity.ts";
import {
  resolveWindowsSystemExecutable,
  validatedWindowsSystemRoot,
} from "./windows-system-path.ts";

describe("provider conformity workflow", () => {
  it("defaults to a read-only compatibility check", () => {
    expect(parseProviderConformityArgs([])).toEqual({
      command: "check",
      dryRun: false,
      waitForCi: false,
      projectDirectory: undefined,
      manifestPath: undefined,
      baseBranch: undefined,
      targetRepo: undefined,
      help: false,
    });
  });

  it("keeps the fallback project directory as structured data", () => {
    expect(
      parseProviderConformityArgs(["update", "--project-dir", "/work/quoted project"]),
    ).toMatchObject({
      command: "update",
      projectDirectory: "/work/quoted project",
    });
  });

  it("uses INIT_CWD for recovery and refuses an ambiguous missing project", () => {
    expect(selectRecoveryProjectDirectory(undefined, "/operator/project")).toBe(
      NodePath.resolve("/operator/project"),
    );
    expect(() => selectRecoveryProjectDirectory(undefined, undefined)).toThrow(
      "requires --project-dir",
    );
    expect(() =>
      assertRecoveryProjectOutsideRepo(
        NodePath.resolve("/club-code"),
        NodePath.resolve("/club-code/packages/shared"),
      ),
    ).toThrow("outside the Cafe Code checkout");
    expect(() =>
      assertRecoveryProjectOutsideRepo(
        NodePath.resolve("/club-code"),
        NodePath.resolve("/operator/project"),
      ),
    ).not.toThrow();
  });

  it("rejects ambiguous commands", () => {
    expect(() => parseProviderConformityArgs(["update", "publish"])).toThrow("Only one");
  });

  it("finds commands only through explicit PATH entries", () => {
    expect(resolvePathCommand("definitely-absent", { PATH: "" }, "linux")).toBeNull();
  });

  it.skipIf(process.platform !== "win32")(
    "runs Corepack through Node's JavaScript entrypoint on Windows",
    () => {
      const nodePath = process.execPath;
      expect(resolveCorepackCommand(nodePath, "win32")).toEqual([
        nodePath,
        expect.stringMatching(/node_modules[\\/]corepack[\\/]dist[\\/]corepack\.js$/u),
      ]);
    },
  );

  it("rejects conflicting or structurally invalid Windows system roots", () => {
    expect(() =>
      validatedWindowsSystemRoot({
        SystemRoot: String.raw`C:\Windows`,
        windir: String.raw`C:\Users\me\Windows`,
      }),
    ).toThrow("invalid");
    expect(
      resolveWindowsSystemExecutable("cmd.exe", {
        SystemRoot: String.raw`D:\Windows`,
        SystemDrive: "D:",
      }),
    ).toBe(String.raw`D:\Windows\System32\cmd.exe`);
  });

  it("classifies portable provider install layouts without host-platform assumptions", () => {
    expect(
      detectInstallKind("codex", ["/home/me/.codex/packages/standalone/releases/0.147/bin/codex"]),
    ).toBe("standalone");
    expect(detectInstallKind("claude", ["/home/me/.local/bin/claude"])).toBe("native");
    expect(detectInstallKind("codex", ["/usr/lib/node_modules/@openai/codex/bin/codex"])).toBe(
      "npm",
    );
    expect(detectInstallKind("claude", ["/home/me/.local/share/pnpm/claude"])).toBe("pnpm");
    expect(detectInstallKind("codex", ["/opt/homebrew/bin/codex"])).toBe("homebrew");
    expect(detectInstallKind("codex", ["/usr/local/Cellar/codex/0.147/bin/codex"])).toBe(
      "homebrew",
    );
    expect(
      detectInstallKind("codex", ["/home/linuxbrew/.linuxbrew/Cellar/codex/0.147/bin/codex"]),
    ).toBe("homebrew");
    expect(
      detectInstallKind("codex", [
        "/opt/homebrew/Cellar/codex/0.147/libexec/lib/node_modules/@openai/codex/bin/codex",
      ]),
    ).toBe("homebrew");
  });

  it("preserves an inherited Linux AppImage relaunch surface", () => {
    const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-appimage-test-"));
    const appImage = NodePath.join(root, "Cafe-Code-test.AppImage");
    writeFileSync(appImage, "fixture");
    chmodSync(appImage, 0o755);
    try {
      expect(launchCommand(root, "linux", { APPIMAGE: appImage })).toEqual([
        realpathSync.native(appImage),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "runs npm through Node's JavaScript entrypoint on Windows",
    () => {
      const nodePath = process.execPath;
      expect(resolveNpmCommand(nodePath, "win32")).toEqual([
        nodePath,
        expect.stringMatching(/node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/u),
      ]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "uses the protected System32 PowerShell boundary on Windows",
    () => {
      expect(resolveWindowsPowerShell({ SystemRoot: String.raw`C:\Windows` })).toBe(
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
    },
  );

  it("wraps Windows provider command shims in trusted cmd.exe with closed structured arguments", () => {
    expect(
      buildProviderInvocation(
        String.raw`C:\Users\me\AppData\Roaming\npm\claude.cmd`,
        ["--version"],
        "win32",
        String.raw`C:\Windows\System32\cmd.exe`,
      ),
    ).toEqual({
      argv: [
        String.raw`C:\Windows\System32\cmd.exe`,
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Users\me\AppData\Roaming\npm\claude.cmd" "--version""`,
      ],
      windowsVerbatimArguments: true,
    });
    expect(() =>
      buildProviderInvocation(
        String.raw`C:\Users\%USERNAME%\claude.cmd`,
        ["--version"],
        "win32",
        String.raw`C:\Windows\System32\cmd.exe`,
      ),
    ).toThrow("cannot be represented safely");
  });

  it.skipIf(process.platform !== "win32")(
    "executes a spaced Windows command shim through the verbatim cmd boundary",
    async () => {
      const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-shim-test-"));
      const shim = NodePath.join(root, "provider shim.cmd");
      writeFileSync(shim, "@echo off\r\necho codex-cli 0.147.0\r\n");
      try {
        const result = await runCommand(buildProviderInvocation(shim, ["--version"]), root, 5_000);
        expect(result).toMatchObject({ exitCode: 0, timedOut: false });
        expect(result.stdout.trim()).toBe("codex-cli 0.147.0");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts source pins only when all compatibility boundaries match", () => {
    const texts = new Map([
      ["apps/server/package.json", '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.224"}}'],
      ["scripts/package.json", '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.224"}}'],
      [
        "packaging/desktop-runtime/package.json",
        '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.224"}}',
      ],
      [
        "packages/effect-codex-app-server/scripts/generate.ts",
        "be6e8eac029b183056b7e4402879f15d2c85f61b",
      ],
      [
        "apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1",
        'Install-ProviderPackage -PackageName "@openai/codex" -Version "0.147.0"\nInstall-ProviderPackage -PackageName "@anthropic-ai/claude-code" -Version "2.1.224"',
      ],
    ]);
    expect(
      validateSourcePins({
        repoRoot: "/repo",
        readText: (path) => texts.get(path.replaceAll("\\", "/").replace("/repo/", "")) ?? "",
      }),
    ).toEqual([]);
  });

  it("rejects managed installer versions paired with the wrong provider package", () => {
    const texts = new Map([
      ["apps/server/package.json", '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.224"}}'],
      ["scripts/package.json", '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.224"}}'],
      [
        "packaging/desktop-runtime/package.json",
        '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.224"}}',
      ],
      [
        "packages/effect-codex-app-server/scripts/generate.ts",
        "be6e8eac029b183056b7e4402879f15d2c85f61b",
      ],
      [
        "apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1",
        'Install-ProviderPackage -PackageName "@openai/codex" -Version "2.1.224"\nInstall-ProviderPackage -PackageName "@anthropic-ai/claude-code" -Version "0.147.0"',
      ],
    ]);
    expect(
      validateSourcePins({
        repoRoot: "/repo",
        readText: (path) => texts.get(path.replaceAll("\\", "/").replace("/repo/", "")) ?? "",
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("does not pair @openai/codex")]));
  });

  it("reports missing and malformed source pin files instead of throwing", () => {
    expect(
      validateSourcePins({
        repoRoot: "/repo",
        readText: (path) => {
          if (path.replaceAll("\\", "/").endsWith("apps/server/package.json")) return "{";
          throw new Error("missing fixture");
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("apps/server/package.json is not valid JSON"),
        expect.stringContaining("scripts/package.json could not be read"),
      ]),
    );
  });

  it("pins package-managed updates and refuses floating standalone drift", () => {
    const npmObservation = {
      provider: "claude" as const,
      binaryPath: "/usr/bin/claude",
      installedVersion: "2.1.220",
      registryVersion: "2.1.226",
      approvedVersion: "2.1.224",
      installKind: "npm" as const,
    };
    expect(providerUpdateCommand(npmObservation)).toContain("@anthropic-ai/claude-code@2.1.224");
    expect(() =>
      providerUpdateCommand({
        ...npmObservation,
        provider: "codex",
        binaryPath: "/home/me/.codex/packages/standalone/codex",
        approvedVersion: "0.147.0",
        installedVersion: "0.146.0",
        registryVersion: "0.148.0",
        installKind: "standalone",
      }),
    ).toThrow("no exact-version interface");
  });

  it("uses the resolved pnpm binary without inheriting the repository package-manager spec", () => {
    const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-pnpm-test-"));
    const pnpm = NodePath.join(root, "pnpm");
    writeFileSync(pnpm, "#!/bin/sh\nexit 0\n");
    chmodSync(pnpm, 0o755);
    try {
      expect(
        providerUpdateCommand(
          {
            provider: "claude",
            binaryPath: "/home/me/.local/share/pnpm/claude",
            installedVersion: "2.1.220",
            registryVersion: "2.1.226",
            approvedVersion: "2.1.224",
            installKind: "pnpm",
          },
          { PATH: root },
          "linux",
        ),
      ).toEqual({ argv: [pnpm, "add", "-g", "@anthropic-ai/claude-code@2.1.224"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an injected POSIX npm path when planning a package-managed update", () => {
    const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-npm-test-"));
    const npm = NodePath.join(root, "npm");
    writeFileSync(npm, "#!/bin/sh\nexit 0\n");
    chmodSync(npm, 0o755);
    try {
      expect(
        providerUpdateCommand(
          {
            provider: "claude",
            binaryPath: "/usr/lib/node_modules/@anthropic-ai/claude-code/claude",
            installedVersion: "2.1.220",
            registryVersion: null,
            approvedVersion: "2.1.224",
            installKind: "npm",
          },
          { PATH: root },
          "linux",
        ),
      ).toEqual([npm, "install", "-g", "@anthropic-ai/claude-code@2.1.224"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps supported provider work when another install layout needs manual action", () => {
    const plan = createUpdatePlan([
      {
        provider: "claude",
        binaryPath: "/usr/lib/node_modules/@anthropic-ai/claude-code/claude",
        installedVersion: "2.1.220",
        registryVersion: "2.1.226",
        approvedVersion: "2.1.224",
        installKind: "npm",
      },
      {
        provider: "codex",
        binaryPath: "/home/me/.codex/packages/standalone/codex",
        installedVersion: "0.146.0",
        registryVersion: "0.148.0",
        approvedVersion: "0.147.0",
        installKind: "standalone",
      },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.observation.provider).toBe("claude");
  });

  it("accepts HTTPS and SSH GitHub remotes and rejects non-GitHub remotes", () => {
    expect(normalizeGitHubRepository("https://github.com/cafeai/cafe-code.git")).toBe(
      "cafeai/cafe-code",
    );
    expect(normalizeGitHubRepository("git@github.com:John-Ryan21337/club-code.git")).toBe(
      "John-Ryan21337/club-code",
    );
    expect(normalizeGitHubRepository("https://example.com/cafeai/cafe-code.git")).toBeNull();
    expect(validateGitHubRepositoryName("cafeai/cafe-code")).toBe("cafeai/cafe-code");
    expect(validateGitHubRepositoryName("cafeai/../users")).toBeNull();
    expect(validateGitHubRepositoryName("cafeai/..")).toBeNull();
  });

  it("rejects ambiguous or non-absolute update manifests", () => {
    const provider = {
      provider: "codex",
      binaryPath: "/usr/bin/codex",
      installedVersion: "0.147.0",
      registryVersion: "0.147.0",
      approvedVersion: "0.147.0",
      installKind: "npm",
    };
    expect(() =>
      parseManifest({
        schemaVersion: 1,
        attemptId: "1-2",
        createdAt: "2026-08-08T00:00:00.000Z",
        repoRoot: "relative",
        commitSha: "a".repeat(40),
        projectDirectory: "/project",
        logPath: "/state/log",
        providers: [provider, provider],
      }),
    ).toThrow("incomplete or ambiguous");
  });

  it("accepts a one-provider manifest and an unavailable advisory registry version", () => {
    expect(
      parseManifest({
        schemaVersion: 1,
        attemptId: "1-2",
        createdAt: "2026-08-08T00:00:00.000Z",
        repoRoot: "/repo",
        commitSha: "a".repeat(40),
        projectDirectory: "/project",
        logPath: "/state/log",
        providers: [
          {
            provider: "codex",
            binaryPath: "/usr/bin/codex",
            installedVersion: "0.147.0",
            registryVersion: null,
            approvedVersion: "0.147.0",
            installKind: "npm",
          },
        ],
      }).providers,
    ).toHaveLength(1);
  });

  it("requires killall output to prove that no Cafe Code process survived", () => {
    expect(killallProvedComplete("No Cafe Code client/server processes found.")).toBe(true);
    expect(
      killallProvedComplete(
        "Cafe Code killall targeted 3 process(es); 0 failed or remained alive.",
      ),
    ).toBe(true);
    expect(
      killallProvedComplete(
        "Cafe Code killall targeted 3 process(es); 1 failed or remained alive.",
      ),
    ).toBe(false);
  });
});
