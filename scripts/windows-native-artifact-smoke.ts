import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runNativeDesktopRuntimeSmoke } from "./native-desktop-runtime-smoke.ts";
import { readJsonFile } from "./json-file.ts";

const PROCESS_TIMEOUT_MS = 15 * 60_000;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 250;
const WINDOWS_CLEANUP_RETRY_ATTEMPTS = 40;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CleanupDependencies {
  readonly platform?: NodeJS.Platform;
  readonly remove?: typeof rm;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface PathDisappearanceDependencies {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

type ManagedProviderSlug = "codex" | "claude";

interface ProcessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly windowsVerbatimArguments?: boolean;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    const timeout = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? PROCESS_TIMEOUT_MS,
    );
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolveProcess({ exitCode, stdout, stderr });
    });
  });
}

function prependWindowsPathEntries(
  env: NodeJS.ProcessEnv,
  entries: readonly string[],
): NodeJS.ProcessEnv {
  const currentPath = env.PATH ?? env.Path ?? "";
  const nextPath = [...entries.filter((entry) => entry.trim().length > 0), currentPath]
    .filter((entry) => entry.trim().length > 0)
    .join(";");
  return {
    ...env,
    PATH: nextPath,
    Path: undefined,
  };
}

function isRetryableWindowsCleanupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function removePathWithRetries(
  targetPath: string,
  dependencies: CleanupDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const remove = dependencies.remove ?? rm;
  const wait = dependencies.sleep ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !isRetryableWindowsCleanupError(error) ||
        attempt >= WINDOWS_CLEANUP_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      // Windows can report parent process exit before the installer/uninstaller
      // releases all file handles in the extracted app directory.
      await wait(WINDOWS_CLEANUP_RETRY_DELAY_MS);
    }
  }
}

export async function waitForPathToDisappear(
  targetPath: string,
  dependencies: PathDisappearanceDependencies = {},
): Promise<boolean> {
  const platform = dependencies.platform ?? process.platform;
  const pathExists = dependencies.exists ?? existsSync;
  const wait = dependencies.sleep ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    if (!pathExists(targetPath)) return true;
    if (platform !== "win32" || attempt >= WINDOWS_CLEANUP_RETRY_ATTEMPTS - 1) {
      return false;
    }
    // NSIS can report exit before post-uninstall file deletion finishes.
    await wait(WINDOWS_CLEANUP_RETRY_DELAY_MS);
  }
}

export function selectWindowsInstaller(fileNames: readonly string[]): string {
  const matches = fileNames.filter(
    (fileName) => /^Cafe-Code-.+-x64\.exe$/.test(fileName) && !fileName.startsWith("Uninstall"),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Windows x64 installer, found ${matches.length}.`);
  }
  return matches[0]!;
}

export function selectInstalledWindowsExecutables(fileNames: readonly string[]): {
  readonly app: string;
  readonly uninstaller: string;
} {
  const appMatches = fileNames.filter((fileName) =>
    /^Cafe Code(?: \([^)]+\))?\.exe$/u.test(fileName),
  );
  const uninstallerMatches = fileNames.filter((fileName) =>
    /^Uninstall Cafe Code(?: \([^)]+\))?\.exe$/u.test(fileName),
  );
  if (appMatches.length !== 1 || uninstallerMatches.length !== 1) {
    throw new Error(
      `Expected one branded application and uninstaller executable; found ${appMatches.length} application and ${uninstallerMatches.length} uninstaller executables.`,
    );
  }
  return { app: appMatches[0]!, uninstaller: uninstallerMatches[0]! };
}

function assertSuccessful(result: ProcessResult, operation: string): void {
  if (result.exitCode === 0) return;

  const details = [
    `exitCode=${result.exitCode === null ? "null" : String(result.exitCode)}`,
    result.stdout.trim().length > 0 ? `stdout:\n${result.stdout.trim()}` : null,
    result.stderr.trim().length > 0 ? `stderr:\n${result.stderr.trim()}` : null,
  ].filter((detail): detail is string => detail !== null);
  throw new Error(`${operation} exited nonzero.\n${details.join("\n\n")}`);
}

async function readUserPathRegistry(): Promise<string> {
  const result = await runProcess("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], {
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : "[unset]";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildManagedProviderProbeEnvironment(
  managedRoot: string,
  provider: ManagedProviderSlug,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const installRoot = join(managedRoot, "providers", provider, "current");
  const binaryDir = join(installRoot, "node_modules", ".bin");
  const nodeDir = join(managedRoot, "node", "current");

  // Match the packaged bundled-runtime launcher: npm shims rely on managed
  // Node and their local .bin directory being ahead of the ambient user PATH.
  return {
    ...prependWindowsPathEntries(baseEnv, [binaryDir, nodeDir]),
    npm_config_prefix: installRoot,
    npm_config_cache: join(managedRoot, "npm-cache"),
  };
}

export function buildWindowsCmdCommand(commandPath: string, args: readonly string[]): string {
  const renderedArgs = args.join(" ");
  return `""${commandPath}"${renderedArgs.length > 0 ? ` ${renderedArgs}` : ""}"`;
}

export function buildWindowsCmdInvocation(
  commandPath: string,
  args: readonly string[],
): {
  readonly command: "cmd.exe";
  readonly args: readonly ["/d", "/s", "/c", string];
  readonly windowsVerbatimArguments: true;
} {
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", buildWindowsCmdCommand(commandPath, args)],
    // cmd.exe parses /c payloads differently than CommandLineToArgvW. Passing
    // the serialized command through Node's default Windows quoting escapes the
    // outer quotes and makes cmd treat the whole payload as a literal filename.
    windowsVerbatimArguments: true,
  };
}

async function assertManagedProviderRuntime(managedRoot: string): Promise<void> {
  const resultPath = join(managedRoot, "install-result.json");
  const result = readRecord(await readJsonFile(resultPath));
  const providers = Array.isArray(result?.providers) ? result.providers.map(readRecord) : [];
  if (
    result?.managedProviderRuntimeEnabled !== true ||
    result.failed === true ||
    providers.length !== 2 ||
    providers.some((provider) => provider?.installed !== true)
  ) {
    throw new Error("Managed provider runtime installation did not complete successfully.");
  }

  const nodePath = join(managedRoot, "node", "current", "node.exe");
  const npmPath = join(managedRoot, "node", "current", "npm.cmd");
  if (!existsSync(nodePath) || !existsSync(npmPath)) {
    throw new Error("Managed Node/npm files are missing.");
  }
  const nodeVersion = await runProcess(nodePath, ["--version"], { timeoutMs: 30_000 });
  assertSuccessful(nodeVersion, "Managed Node version probe");
  if (nodeVersion.stdout.trim() !== "v24.13.1") {
    throw new Error("Managed Node version does not match the packaged policy.");
  }

  for (const [provider, executable] of [
    ["codex", "codex.cmd"],
    ["claude", "claude.cmd"],
  ] as const) {
    const installRoot = join(managedRoot, "providers", provider, "current");
    const shim = join(installRoot, "node_modules", ".bin", executable);
    if (!existsSync(shim)) throw new Error(`Managed ${provider} shim is missing.`);
    const probeInvocation = buildWindowsCmdInvocation(shim, ["--version"]);
    const probe = await runProcess(probeInvocation.command, probeInvocation.args, {
      env: buildManagedProviderProbeEnvironment(managedRoot, provider, process.env),
      timeoutMs: 60_000,
      windowsVerbatimArguments: probeInvocation.windowsVerbatimArguments,
    });
    assertSuccessful(probe, `Managed ${provider} version probe`);
  }
}

export async function runWindowsNativeArtifactSmoke(
  releaseDir = resolve("release"),
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Windows native artifact smoke must run on Windows.");
  }
  if (process.env.CI !== "true" && process.env.CAFE_CODE_ALLOW_NATIVE_INSTALLER_SMOKE !== "1") {
    throw new Error(
      "Windows installer smoke writes managed provider state; run it in CI or set CAFE_CODE_ALLOW_NATIVE_INSTALLER_SMOKE=1 explicitly.",
    );
  }
  const installer = join(releaseDir, selectWindowsInstaller(await readdir(releaseDir)));
  const smokeRoot = await mkdtemp(join(tmpdir(), "cafecode-windows-artifact-smoke-"));
  const installDir = join(smokeRoot, "Cafe Code");
  const managedRoot = join(process.env.LOCALAPPDATA ?? "", "CafeCode", "managed");
  const pathBefore = await readUserPathRegistry();
  let uninstallerPath: string | undefined;

  try {
    const install = await runProcess(installer, ["/S", `/D=${installDir}`]);
    assertSuccessful(install, "NSIS install");
    const installedExecutables = selectInstalledWindowsExecutables(await readdir(installDir));
    const appPath = join(installDir, installedExecutables.app);
    uninstallerPath = join(installDir, installedExecutables.uninstaller);
    if (!existsSync(appPath) || !existsSync(uninstallerPath)) {
      throw new Error("NSIS install did not create the application and uninstaller executables.");
    }

    await assertManagedProviderRuntime(managedRoot);
    if ((await readUserPathRegistry()) !== pathBefore) {
      throw new Error("The managed provider installer changed the user PATH.");
    }
    await runNativeDesktopRuntimeSmoke({ appPath });

    const uninstall = await runProcess(uninstallerPath, ["/S"], { timeoutMs: 5 * 60_000 });
    assertSuccessful(uninstall, "NSIS uninstall");
    if (!(await waitForPathToDisappear(appPath)))
      throw new Error("NSIS uninstall left the application executable behind.");
    uninstallerPath = undefined;
    console.info("Windows NSIS install/runtime/managed-provider/uninstall smoke passed.");
  } finally {
    if (uninstallerPath && existsSync(uninstallerPath)) {
      await runProcess(uninstallerPath, ["/S"], { timeoutMs: 5 * 60_000 }).catch(() => undefined);
    }
    await removePathWithRetries(smokeRoot);
  }
}

if (import.meta.main) {
  await runWindowsNativeArtifactSmoke(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
