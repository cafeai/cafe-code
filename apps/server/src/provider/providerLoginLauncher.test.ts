// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, rmSync } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProviderLoginCmdScript,
  buildProviderLoginCmdStartCommand,
  buildProviderLoginPowerShellCommand,
  resolveProviderLoginLaunchPlan,
} from "./providerLoginLauncher.ts";
import { CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV } from "./managedProviderRuntime.ts";
import { debugProviderHome, type ProviderDataProfile } from "./debugProviderProfile.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), `cafecode-${name}-`));
  tempRoots.push(root);
  return root;
}

function settingsWithInstance(
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: instance,
    } as ServerSettings["providerInstances"],
  };
}

function runResolve(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  baseEnv: NodeJS.ProcessEnv,
  profile?: ProviderDataProfile,
) {
  return Effect.runPromise(
    resolveProviderLoginLaunchPlan({
      input: { instanceId },
      settings,
      baseEnv,
      platform: "win32",
      profile,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("providerLoginLauncher", () => {
  it("uses the same private Debug Codex account for login, history index and ordinary driver admission", async () => {
    const profile = { dataProfile: "debug" as const, baseDir: tempDir("debug-login-profile") };
    const settings = settingsWithInstance(CODEX_INSTANCE_ID, {
      driver: CODEX_DRIVER,
      enabled: true,
      config: { runtimeSource: "bundled", binaryPath: "codex" },
    });
    const plan = await runResolve(
      settings,
      CODEX_INSTANCE_ID,
      {
        [CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV]: "D:\\CafeManaged",
        CODEX_HOME: "production-home",
        CODEX_SQLITE_HOME: "production-index",
        OPENAI_API_KEY: "inherited-private-key",
        PATH: "C:\\Windows\\System32",
      },
      profile,
    );
    const home = debugProviderHome(profile, "codex", CODEX_INSTANCE_ID);
    expect(plan.env.CODEX_HOME).toBe(home);
    expect(plan.env.CODEX_SQLITE_HOME).toBe(home);
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
    expect(plan.cwd).toBe(home);
    expect(plan.binaryPath).toContain("CafeManaged");
  });

  it("pins Debug Claude login to its private config directory without terminal account fallback", async () => {
    const profile = {
      dataProfile: "debug" as const,
      baseDir: tempDir("debug-claude-login-profile"),
    };
    const settings = settingsWithInstance(CLAUDE_INSTANCE_ID, {
      driver: CLAUDE_DRIVER,
      enabled: true,
      config: { runtimeSource: "bundled", binaryPath: "claude" },
    });
    const plan = await runResolve(
      settings,
      CLAUDE_INSTANCE_ID,
      {
        [CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV]: "D:\\CafeManaged",
        CLAUDE_CONFIG_DIR: "production-config",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "production-keychain",
        ANTHROPIC_AUTH_TOKEN: "inherited-private-token",
      },
      profile,
    );
    const home = debugProviderHome(profile, "claudeAgent", CLAUDE_INSTANCE_ID);
    expect(plan.env.HOME).toBe(home);
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(NodePath.join(home, ".claude"));
    expect(plan.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.env.DISABLE_AUTOUPDATER).toBe("1");
    expect(plan.cwd).toBe(home);
  });
  it("resolves bundled Codex login to the managed shim and shared auth home", async () => {
    const sharedHome = tempDir("codex-shared");
    const shadowHome = tempDir("codex-shadow");
    const settings = settingsWithInstance(CODEX_INSTANCE_ID, {
      driver: CODEX_DRIVER,
      config: {
        runtimeSource: "bundled",
        binaryPath: "codex",
        homePath: sharedHome,
        shadowHomePath: shadowHome,
      },
    });

    const plan = await runResolve(settings, CODEX_INSTANCE_ID, {
      [CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV]: "D:\\CafeManaged",
      PATH: "C:\\Windows\\System32",
    });

    expect(plan.commandDisplay).toBe("codex login");
    expect(plan.binaryPath).toBe(
      "D:\\CafeManaged\\providers\\codex\\current\\node_modules\\.bin\\codex.cmd",
    );
    expect(plan.env.CODEX_HOME).toBe(sharedHome);
    expect(plan.env.PATH?.split(";").slice(0, 2)).toEqual([
      "D:\\CafeManaged\\providers\\codex\\current\\node_modules\\.bin",
      "D:\\CafeManaged\\node\\current",
    ]);
  });

  it("resolves bundled Claude login to the managed shim and Claude auth environment", async () => {
    const homePath = tempDir("claude-home");
    const settings = settingsWithInstance(CLAUDE_INSTANCE_ID, {
      driver: CLAUDE_DRIVER,
      config: {
        runtimeSource: "bundled",
        binaryPath: "claude",
        homePath,
        maxOutputTokens: 128_000,
      },
    });

    const plan = await runResolve(settings, CLAUDE_INSTANCE_ID, {
      [CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV]: "D:\\CafeManaged",
      PATH: "C:\\Windows\\System32",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    });

    expect(plan.commandDisplay).toBe("claude login");
    expect(plan.binaryPath).toBe(
      "D:\\CafeManaged\\providers\\claude\\current\\node_modules\\.bin\\claude.cmd",
    );
    expect(plan.env.HOME).toBe(homePath);
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(NodePath.join(homePath, ".claude"));
    expect(plan.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
  });

  it("quotes the exact managed shim path in the PowerShell command", () => {
    const command = buildProviderLoginPowerShellCommand({
      instanceId: CODEX_INSTANCE_ID,
      provider: CODEX_DRIVER,
      commandName: "codex",
      commandDisplay: "codex login",
      binaryPath: "C:\\Cafe's Managed\\codex.cmd",
      cwd: "C:\\Users\\throw",
      env: {},
    });

    expect(command).toContain("& 'C:\\Cafe''s Managed\\codex.cmd' login");
    expect(command).toContain("codex login exited with code ");
  });

  it("launches provider login through cmd start with an encoded PowerShell command", () => {
    const command = buildProviderLoginCmdStartCommand({
      instanceId: CODEX_INSTANCE_ID,
      provider: CODEX_DRIVER,
      commandName: "codex",
      commandDisplay: "codex login",
      binaryPath: "C:\\Cafe's Managed\\codex.cmd",
      cwd: "C:\\Users\\throw",
      env: {
        SystemRoot: "C:\\Windows",
      },
    });

    expect(command).toContain('start "Cafe Code codex login" /D "C:\\Users\\throw"');
    expect(command).toContain('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"');

    const encodedCommand = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
    expect(encodedCommand).toBeTruthy();
    const decodedCommand = Buffer.from(encodedCommand!, "base64").toString("utf16le");
    expect(decodedCommand).toContain("& 'C:\\Cafe''s Managed\\codex.cmd' login");
    expect(decodedCommand).toContain("codex login exited with code ");
  });

  it("wraps the cmd start command in a short-lived batch launcher", () => {
    const script = buildProviderLoginCmdScript({
      instanceId: CODEX_INSTANCE_ID,
      provider: CODEX_DRIVER,
      commandName: "codex",
      commandDisplay: "codex login",
      binaryPath: "C:\\Cafe%Managed\\codex.cmd",
      cwd: "C:\\Users\\throw%name",
      env: {
        SystemRoot: "C:\\Windows",
      },
    });

    expect(script).toContain("@echo off\r\nsetlocal\r\nstart ");
    expect(script).toContain('"C:\\Users\\throw%%name"');
    expect(script).toContain("if errorlevel 1 exit /b %ERRORLEVEL%");
    expect(script).toContain("exit /b 0");
  });
});
