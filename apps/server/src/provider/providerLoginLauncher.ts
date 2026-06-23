// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, promises as NodeFsPromises } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";

import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ServerProviderLoginError,
  type ProviderInstanceId,
  type ServerProviderLoginInput,
  type ServerProviderLoginResult,
  type ServerSettings,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { withDefaultCodexShadowHome } from "./Drivers/CodexDriver.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  resolveProviderRuntimeEnvironment,
  type ResolveManagedProviderRuntimeOptions,
} from "./managedProviderRuntime.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const CODEX_PACKAGE = {
  provider: CODEX_DRIVER,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
} as const;

const CLAUDE_PACKAGE = {
  provider: CLAUDE_DRIVER,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: null,
} as const;
const isServerProviderLoginError = Schema.is(ServerProviderLoginError);
const decodeCodexSettingsUnknown = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettingsUnknown = Schema.decodeUnknownEffect(ClaudeSettings);

export interface ProviderLoginLaunchPlan {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly commandName: "codex" | "claude";
  readonly commandDisplay: "codex login" | "claude login";
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolveProviderLoginLaunchPlanOptions {
  readonly input: ServerProviderLoginInput;
  readonly settings: ServerSettings;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

function loginError(
  instanceId: ProviderInstanceId,
  reason: string,
  cause?: unknown,
): ServerProviderLoginError {
  return new ServerProviderLoginError({
    instanceId,
    reason,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function preserveOrWrapLoginError(
  instanceId: ProviderInstanceId,
  reason: string,
  cause: unknown,
): ServerProviderLoginError {
  return isServerProviderLoginError(cause) ? cause : loginError(instanceId, reason, cause);
}

const decodeCodexSettings = (instanceId: ProviderInstanceId, value: unknown) =>
  decodeCodexSettingsUnknown(value).pipe(
    Effect.mapError((cause) =>
      loginError(instanceId, `Provider instance settings are invalid: ${cause.message}.`, cause),
    ),
  );

const decodeClaudeSettings = (instanceId: ProviderInstanceId, value: unknown) =>
  decodeClaudeSettingsUnknown(value).pipe(
    Effect.mapError((cause) =>
      loginError(instanceId, `Provider instance settings are invalid: ${cause.message}.`, cause),
    ),
  );

function resolveRuntime(input: {
  readonly instanceId: ProviderInstanceId;
  readonly platform: NodeJS.Platform;
  readonly options: ResolveManagedProviderRuntimeOptions;
}) {
  const runtime = resolveProviderRuntimeEnvironment({
    ...input.options,
    platform: input.platform,
  });
  if (runtime.runtimeSource !== "bundled") {
    return Effect.fail(
      loginError(
        input.instanceId,
        "Managed provider login is available only when the provider runtime source is bundled.",
      ),
    );
  }
  if (runtime.unavailableReason) {
    return Effect.fail(loginError(input.instanceId, runtime.unavailableReason));
  }
  return Effect.succeed(runtime);
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildProviderLoginPowerShellCommand(plan: ProviderLoginLaunchPlan): string {
  const title = `Cafe Code ${plan.commandName} login`;
  return [
    `$Host.UI.RawUI.WindowTitle = ${quotePowerShellString(title)}`,
    `& ${quotePowerShellString(plan.binaryPath)} login`,
    "$code = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }",
    `if ($code -ne 0) { Write-Host ""; Write-Host (${quotePowerShellString(`${plan.commandDisplay} exited with code `)} + $code) }`,
  ].join("; ");
}

function powerShellPath(env: NodeJS.ProcessEnv): string {
  const windowsRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return NodePath.win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function cmdPath(env: NodeJS.ProcessEnv): string {
  const windowsRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return NodePath.win32.join(windowsRoot, "System32", "cmd.exe");
}

function quoteCmdArgument(value: string): string {
  return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

export function buildProviderLoginCmdStartCommand(plan: ProviderLoginLaunchPlan): string {
  return [
    "start",
    quoteCmdArgument(`Cafe Code ${plan.commandName} login`),
    "/D",
    quoteCmdArgument(plan.cwd),
    quoteCmdArgument(powerShellPath(plan.env)),
    "-NoLogo",
    "-NoProfile",
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShellCommand(buildProviderLoginPowerShellCommand(plan)),
  ].join(" ");
}

export function buildProviderLoginCmdScript(plan: ProviderLoginLaunchPlan): string {
  return [
    "@echo off",
    "setlocal",
    buildProviderLoginCmdStartCommand(plan),
    "if errorlevel 1 exit /b %ERRORLEVEL%",
    "exit /b 0",
    "",
  ].join("\r\n");
}

function awaitShellLauncher(
  plan: ProviderLoginLaunchPlan,
  launcherPath: string,
): Effect.Effect<void, ServerProviderLoginError> {
  return Effect.callback<void, ServerProviderLoginError>((resume) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;

    const cleanup = () => {
      if (!child) return;
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const complete = (effect: Effect.Effect<void, ServerProviderLoginError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };
    const onError = (error: Error) =>
      complete(
        Effect.fail(
          loginError(
            plan.instanceId,
            `Windows shell launcher failed for ${plan.commandDisplay}.`,
            error,
          ),
        ),
      );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        complete(Effect.void);
        return;
      }
      complete(
        Effect.fail(
          loginError(
            plan.instanceId,
            `Windows shell launch exited with ${code === null ? `signal ${signal}` : `code ${code}`}.`,
          ),
        ),
      );
    };

    try {
      // The short-lived batch file keeps `cmd.exe start` quoting out of
      // Node's `cmd /c "<command>"` command-line serialization. Direct
      // detached `powershell.exe` spawning from Electron's backend child
      // can report success while never surfacing a window.
      child = spawn(cmdPath(plan.env), ["/d", "/c", launcherPath], {
        cwd: plan.cwd,
        detached: false,
        env: plan.env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      resume(
        Effect.fail(
          loginError(
            plan.instanceId,
            `Windows shell launcher failed for ${plan.commandDisplay}.`,
            error,
          ),
        ),
      );
      return;
    }

    child.once("error", onError);
    child.once("exit", onExit);

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child?.kill();
    });
  });
}

function spawnVisiblePowerShell(
  plan: ProviderLoginLaunchPlan,
): Effect.Effect<void, ServerProviderLoginError> {
  return Effect.gen(function* () {
    const launcherDir = yield* Effect.tryPromise({
      try: () => NodeFsPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cafecode-provider-login-")),
      catch: (cause) =>
        loginError(plan.instanceId, `Failed to open PowerShell for ${plan.commandDisplay}.`, cause),
    });
    const launcherPath = NodePath.join(launcherDir, `${plan.commandName}-login.cmd`);
    const cleanup = Effect.tryPromise({
      try: () => NodeFsPromises.rm(launcherDir, { recursive: true, force: true }),
      catch: () => undefined,
    }).pipe(Effect.ignore);

    yield* Effect.tryPromise({
      try: () => NodeFsPromises.writeFile(launcherPath, buildProviderLoginCmdScript(plan), "utf8"),
      catch: (cause) =>
        loginError(plan.instanceId, `Failed to open PowerShell for ${plan.commandDisplay}.`, cause),
    }).pipe(
      Effect.andThen(
        awaitShellLauncher(plan, launcherPath).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError((cause) =>
            preserveOrWrapLoginError(
              plan.instanceId,
              `Windows shell launcher did not exit within 5000ms for ${plan.commandDisplay}.`,
              cause,
            ),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        preserveOrWrapLoginError(
          plan.instanceId,
          `Failed to open PowerShell for ${plan.commandDisplay}.`,
          cause,
        ),
      ),
      Effect.ensuring(cleanup),
    );
  });
}

const resolveCodexLoginPlan = Effect.fn("ProviderLoginLauncher.resolveCodex")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<
  ProviderLoginLaunchPlan,
  ServerProviderLoginError,
  FileSystem.FileSystem | Path.Path
> {
  const codexSettings = yield* decodeCodexSettings(input.instanceId, input.config);
  const layoutConfig = withDefaultCodexShadowHome({
    instanceId: input.instanceId,
    config: codexSettings,
  });
  const homeLayout = yield* resolveCodexHomeLayout(layoutConfig);
  const authSource =
    codexSettings.homePath.trim().length === 0 && codexSettings.shadowHomePath.trim().length > 0
      ? "shadow"
      : "shared";
  const runtime = yield* resolveRuntime({
    instanceId: input.instanceId,
    platform: input.platform,
    options: {
      provider: CODEX_DRIVER,
      runtimeSource: layoutConfig.runtimeSource,
      systemBinaryPath: layoutConfig.binaryPath,
      packageMaintenance: CODEX_PACKAGE,
      baseEnv: input.environment,
    },
  });

  // A Cafe-default Codex shadow home copies auth from the shared ~/.codex
  // location before status checks. Launching login against that same source
  // keeps the button equivalent to the manual `codex login` repair path while
  // explicit shadow-only instances still log into their isolated shadow home.
  yield* materializeCodexShadowHome(homeLayout, { authSource }).pipe(
    Effect.mapError((cause) => loginError(input.instanceId, cause.message, cause)),
  );
  const authHomePath =
    authSource === "shadow"
      ? (homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath)
      : homeLayout.sharedHomePath;

  return {
    instanceId: input.instanceId,
    provider: CODEX_DRIVER,
    commandName: "codex",
    commandDisplay: "codex login",
    binaryPath: runtime.binaryPath,
    cwd: NodeOS.homedir(),
    env: {
      ...runtime.env,
      CODEX_HOME: authHomePath,
    },
  } satisfies ProviderLoginLaunchPlan;
});

const resolveClaudeLoginPlan = Effect.fn("ProviderLoginLauncher.resolveClaude")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<ProviderLoginLaunchPlan, ServerProviderLoginError, Path.Path> {
  const claudeSettings = yield* decodeClaudeSettings(input.instanceId, input.config);
  const runtime = yield* resolveRuntime({
    instanceId: input.instanceId,
    platform: input.platform,
    options: {
      provider: CLAUDE_DRIVER,
      runtimeSource: claudeSettings.runtimeSource,
      systemBinaryPath: claudeSettings.binaryPath,
      packageMaintenance: CLAUDE_PACKAGE,
      baseEnv: input.environment,
    },
  });
  const env = yield* makeClaudeEnvironment(claudeSettings, runtime.env);

  return {
    instanceId: input.instanceId,
    provider: CLAUDE_DRIVER,
    commandName: "claude",
    commandDisplay: "claude login",
    binaryPath: runtime.binaryPath,
    cwd: NodeOS.homedir(),
    env,
  } satisfies ProviderLoginLaunchPlan;
});

export const resolveProviderLoginLaunchPlan = Effect.fn(
  "ProviderLoginLauncher.resolveProviderLoginLaunchPlan",
)(function* (
  options: ResolveProviderLoginLaunchPlanOptions,
): Effect.fn.Return<
  ProviderLoginLaunchPlan,
  ServerProviderLoginError,
  FileSystem.FileSystem | Path.Path
> {
  const instanceId = options.input.instanceId;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return yield* loginError(instanceId, "Managed provider login is supported only on Windows.");
  }

  const configMap = deriveProviderInstanceConfigMap(options.settings);
  const instanceConfig = configMap[instanceId];
  if (!instanceConfig) {
    return yield* loginError(instanceId, `Provider instance '${instanceId}' was not found.`);
  }
  if (instanceConfig.enabled === false) {
    return yield* loginError(instanceId, `Provider instance '${instanceId}' is disabled.`);
  }

  const environment = mergeProviderInstanceEnvironment(instanceConfig.environment, options.baseEnv);
  switch (instanceConfig.driver) {
    case CODEX_DRIVER:
      return yield* resolveCodexLoginPlan({
        instanceId,
        config: instanceConfig.config,
        environment,
        platform,
      });
    case CLAUDE_DRIVER:
      return yield* resolveClaudeLoginPlan({
        instanceId,
        config: instanceConfig.config,
        environment,
        platform,
      });
    default:
      return yield* loginError(
        instanceId,
        `Provider '${instanceConfig.driver}' does not support managed login.`,
      );
  }
});

export const launchProviderLoginPlan = Effect.fn("ProviderLoginLauncher.launch")(function* (
  plan: ProviderLoginLaunchPlan,
): Effect.fn.Return<void, ServerProviderLoginError> {
  if (process.platform !== "win32") {
    return yield* loginError(
      plan.instanceId,
      "Managed provider login is supported only on Windows.",
    );
  }
  if (!existsSync(plan.binaryPath)) {
    return yield* loginError(
      plan.instanceId,
      `Cafe-managed ${plan.commandName} runtime is not installed at the expected path.`,
    );
  }
  yield* spawnVisiblePowerShell(plan);
});

export const loginProvider = Effect.fn("ProviderLoginLauncher.loginProvider")(function* (
  input: ServerProviderLoginInput,
): Effect.fn.Return<
  ServerProviderLoginResult,
  ServerProviderLoginError,
  ServerSettingsService | FileSystem.FileSystem | Path.Path
> {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError((cause) => loginError(input.instanceId, cause.detail, cause)),
  );
  const plan = yield* resolveProviderLoginLaunchPlan({ input, settings });
  yield* launchProviderLoginPlan(plan);
  return {
    instanceId: plan.instanceId,
    provider: plan.provider,
    command: plan.commandDisplay,
    message: `Opened ${plan.commandDisplay} in PowerShell.`,
  };
});
