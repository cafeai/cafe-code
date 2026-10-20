import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync } from "node:fs";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";

import { runNativeDesktopRuntimeSmoke } from "./native-desktop-runtime-smoke.ts";
import { readJsonFile } from "./json-file.ts";
import { REPOSITORY_NODE_VERSION } from "./lib/node-version.ts";

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
    // This native wait owns an external child/stream lifetime; a virtual
    // Effect clock must not replace its existing deadline or cleanup.
    // @effect-diagnostics-next-line globalTimers:off
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
  // This native wait owns an external child/stream lifetime; a virtual
  // Effect clock must not replace its existing deadline or cleanup.
  // @effect-diagnostics-next-line globalTimers:off
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

export function summarizeManagedBootstrapFailure(source: string): string {
  const receipts = source
    .slice(-16_384)
    .split(/\r?\n/)
    .filter((line) =>
      /^\[[0-9T:.+Z-]+\] Bootstrap failure phase=(?:resolve|guard|prepare|generation|settings|publication) nativeExit=(?:unknown|-?\d{1,11}) line=\d{1,6} hresult=-?\d{1,11}$/u.test(
        line,
      ),
    );
  return receipts.at(-1) ?? "No bounded bootstrap failure receipt was written.";
}

async function readManagedBootstrapFailure(): Promise<string> {
  const path = join(process.env.LOCALAPPDATA ?? "", "CafeCode", "installer-managed-runtime.log");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 65_536)
      return "Installer log was absent or outside the fixture read limit.";
    return summarizeManagedBootstrapFailure(await readFile(path, "utf8"));
  } catch {
    return "Installer log was unavailable.";
  }
}

/** Fixed presence receipts survive the owned install-directory cleanup without
 * publishing installer output, paths, provider data or arbitrary log contents. */
export function inspectWindowsInstallFailure(
  installDir: string,
  cafeRoot: string,
  pathExists: (path: string) => boolean = existsSync,
) {
  return {
    appArchive: pathExists(join(installDir, "resources", "app.asar")),
    bootstrapScript: pathExists(
      join(installDir, "resources", "managed-runtime", "install-managed-provider-runtime.ps1"),
    ),
    managedNode: pathExists(
      join(installDir, "resources", "managed-runtime", "node", "win-x64", "node.exe"),
    ),
    installerOptions: pathExists(join(cafeRoot, "installer-options.json")),
    bootstrapLog: pathExists(join(cafeRoot, "installer-managed-runtime.log")),
    installResult: pathExists(join(cafeRoot, "managed", "install-result.json")),
    activeRuntime: pathExists(join(cafeRoot, "managed", "active-runtime.json")),
  };
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
  generation?: string,
): NodeJS.ProcessEnv {
  const selectedRoot = generation ? join(managedRoot, "generations", generation) : managedRoot;
  const installRoot = join(selectedRoot, "providers", provider, ...(generation ? [] : ["current"]));
  const binaryDir = join(installRoot, "node_modules", ".bin");
  const nodeDir = join(selectedRoot, "node", ...(generation ? [] : ["current"]));

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

  const active = (await readJsonFile(join(managedRoot, "active-runtime.json"))) as {
    version?: unknown;
    generation?: unknown;
  };
  if (
    active.version !== 1 ||
    typeof active.generation !== "string" ||
    !/^[a-f0-9]{32}$/u.test(active.generation)
  )
    throw new Error("Managed activation record is invalid.");
  const selectedRoot = join(managedRoot, "generations", active.generation);
  const nodePath = join(selectedRoot, "node", "node.exe");
  const npmPath = join(selectedRoot, "node", "npm.cmd");
  if (!existsSync(nodePath) || !existsSync(npmPath)) {
    throw new Error("Managed Node/npm files are missing.");
  }
  const nodeVersion = await runProcess(nodePath, ["--version"], { timeoutMs: 30_000 });
  assertSuccessful(nodeVersion, "Managed Node version probe");
  if (nodeVersion.stdout.trim() !== `v${REPOSITORY_NODE_VERSION}`) {
    throw new Error("Managed Node version does not match the packaged policy.");
  }

  for (const [provider, executable] of [
    ["codex", "codex.cmd"],
    ["claude", "claude.cmd"],
  ] as const) {
    const installRoot = join(selectedRoot, "providers", provider);
    const shim = join(installRoot, "node_modules", ".bin", executable);
    if (!existsSync(shim)) throw new Error(`Managed ${provider} shim is missing.`);
    const probeInvocation = buildWindowsCmdInvocation(shim, ["--version"]);
    const probe = await runProcess(probeInvocation.command, probeInvocation.args, {
      env: buildManagedProviderProbeEnvironment(
        managedRoot,
        provider,
        process.env,
        active.generation,
      ),
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
    // NSIS parses /D= as an unquoted final command-line tail, even for spaces.
    // Node's ordinary Windows argv quoting changes that grammar. Keep this
    // narrowly scoped native installer call shell-free and verbatim.
    const install = await runProcess(installer, ["/S", `/D=${installDir}`], {
      windowsVerbatimArguments: true,
    });
    if (install.exitCode !== 0) {
      const filesystem = await statfs(smokeRoot).catch(() => undefined);
      const receipt = {
        ...inspectWindowsInstallFailure(installDir, join(managedRoot, "..")),
        availableDiskBytes: filesystem ? filesystem.bavail * filesystem.bsize : null,
      };
      throw new Error(
        `NSIS install exited nonzero (${install.exitCode}). ${await readManagedBootstrapFailure()} Installation phase: ${JSON.stringify(receipt)}`,
      );
    }
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
    Effect.runSync(
      Console.info("Windows NSIS install/runtime/managed-provider/uninstall smoke passed."),
    );
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
