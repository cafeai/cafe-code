#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeProviderVersionOutput,
  PROVIDER_COMPATIBILITY_MATRIX,
  type ProviderCompatibilityName,
} from "@cafecode/shared/providerCompatibility";

import { resolveWindowsSystemExecutable } from "./windows-system-path.ts";

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const REPOSITORY_GATE_TIMEOUT_MS = 45 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 60_000;
const SHORTCUT_REPAIR_TIMEOUT_MS = 60_000;
const REGISTRY_TIMEOUT_MS = 8_000;
const GITHUB_MUTATION_TIMEOUT_MS = 60_000;
const GITHUB_CI_TIMEOUT_MS = 4 * 60 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const HELPER_WAIT_MS = 1_500;

type ConformityCommand = "check" | "smoke" | "update" | "publish" | "helper";

export interface ProviderConformityArgs {
  readonly command: ConformityCommand;
  readonly dryRun: boolean;
  readonly waitForCi: boolean;
  readonly projectDirectory: string | undefined;
  readonly manifestPath: string | undefined;
  readonly baseBranch: string | undefined;
  readonly targetRepo: string | undefined;
  readonly help: boolean;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CommandInvocation {
  readonly argv: ReadonlyArray<string>;
  readonly windowsVerbatimArguments?: boolean;
}

type CommandInput = ReadonlyArray<string> | CommandInvocation;

function commandInvocation(command: CommandInput): CommandInvocation {
  return "argv" in command ? command : { argv: command };
}

export interface ProviderObservation {
  readonly provider: ProviderCompatibilityName;
  readonly binaryPath: string;
  readonly installedVersion: string;
  readonly registryVersion: string | null;
  readonly approvedVersion: string;
  readonly installKind: "native" | "standalone" | "npm" | "pnpm" | "homebrew" | "unknown";
}

interface ProviderUpdateManifest {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly createdAt: string;
  readonly repoRoot: string;
  readonly commitSha: string;
  readonly projectDirectory: string;
  readonly logPath: string;
  readonly providers: ReadonlyArray<ProviderObservation>;
}

const usage = `Usage:
  yarn providers:conform [check]
  yarn providers:conform smoke
  yarn providers:conform update [--project-dir <path>] [--dry-run]
  yarn providers:conform publish [--wait-ci] [--base <branch>] [--target-repo <owner/name>]

check     Compare installed, registry, source-pin, and approved versions.
smoke     Validate source pins without provider binaries or network access (CI-safe).
update    Run repository gates, then schedule a detached exact-version CLI update and relaunch.
publish   On a provider-conformity/* branch, run gates, push, and create/reuse a draft PR.

The update command refuses to install a registry release that has not already been audited,
pinned in the compatibility matrix, and tested in Cafe Code source.
`;

function valueAfter(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${flag}.`);
  return value;
}

export function parseProviderConformityArgs(args: ReadonlyArray<string>): ProviderConformityArgs {
  let command: ConformityCommand = "check";
  let dryRun = false;
  let waitForCi = false;
  let projectDirectory: string | undefined;
  let manifestPath: string | undefined;
  let baseBranch: string | undefined;
  let targetRepo: string | undefined;
  let help = false;
  let commandSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === "check" ||
      arg === "smoke" ||
      arg === "update" ||
      arg === "publish" ||
      arg === "helper"
    ) {
      if (commandSeen) throw new Error("Only one conformity command may be selected.");
      command = arg;
      commandSeen = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--wait-ci") {
      waitForCi = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--project-dir") {
      projectDirectory = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--project-dir=")) {
      projectDirectory = arg.slice("--project-dir=".length);
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
      continue;
    }
    if (arg === "--base") {
      baseBranch = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--base=")) {
      baseBranch = arg.slice("--base=".length);
      continue;
    }
    if (arg === "--target-repo") {
      targetRepo = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--target-repo=")) {
      targetRepo = arg.slice("--target-repo=".length);
      continue;
    }
    throw new Error(`Unknown option: ${String(arg)}`);
  }

  return {
    command,
    dryRun,
    waitForCi,
    projectDirectory,
    manifestPath,
    baseBranch,
    targetRepo,
    help,
  };
}

export function selectRecoveryProjectDirectory(
  explicitProjectDirectory: string | undefined,
  initCwd: string | undefined,
): string {
  const selected = explicitProjectDirectory?.trim() || initCwd?.trim();
  if (!selected) {
    throw new Error(
      "Provider update requires --project-dir (or the package manager's INIT_CWD) so recovery never opens a provider in the Cafe Code checkout by accident.",
    );
  }
  return NodePath.resolve(selected);
}

export function assertRecoveryProjectOutsideRepo(repoRoot: string, projectDirectory: string): void {
  const relative = NodePath.relative(repoRoot, projectDirectory);
  if (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  ) {
    throw new Error(
      "Recovery project directory must be outside the Cafe Code checkout so fallback never opens a provider in Cafe Code by accident.",
    );
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePathCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of pathValue.split(NodePath.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = NodePath.join(directory, `${command}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
      const originalCaseCandidate = NodePath.join(directory, `${command}${extension}`);
      if (originalCaseCandidate !== candidate && isExecutable(originalCaseCandidate)) {
        return originalCaseCandidate;
      }
    }
  }
  return null;
}

interface BoundedBytes {
  readonly chunks: Buffer[];
  size: number;
}

function appendBounded(output: BoundedBytes, chunk: Uint8Array): void {
  const remaining = MAX_OUTPUT_BYTES - output.size;
  if (remaining <= 0) return;
  const bytes = Buffer.from(chunk);
  const accepted = bytes.subarray(0, Math.min(bytes.byteLength, remaining));
  output.chunks.push(accepted);
  output.size += accepted.byteLength;
}

function decodeBounded(output: BoundedBytes): string {
  return Buffer.concat(output.chunks, output.size).toString("utf8");
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (typeof child.pid !== "number") return;
  if (process.platform === "win32") {
    try {
      const taskkill = resolveWindowsSystemExecutable("taskkill.exe");
      if (isExecutable(taskkill)) {
        await new Promise<void>((resolve) => {
          const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          const timer = setTimeout(() => {
            killer.kill();
            resolve();
          }, 5_000);
          killer.once("error", () => {
            clearTimeout(timer);
            resolve();
          });
          killer.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } catch {
      // Fall through to the direct child kill if the protected system path
      // cannot be established from a consistent Windows environment.
    }
    child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runCommand(
  command: CommandInput,
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const invocation = commandInvocation(command);
  const [executable, ...args] = invocation.argv;
  if (!executable) throw new Error("Cannot run an empty command.");
  return await new Promise<CommandResult>((resolve, reject) => {
    const stdout: BoundedBytes = { chunks: [], size: 0 };
    const stderr: BoundedBytes = { chunks: [], size: 0 };
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signals = ["SIGINT", "SIGTERM"] as const;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    };
    for (const signal of signals) {
      const handler = () => {
        if (settled) return;
        settled = true;
        cleanup();
        void terminateProcessTree(child).finally(() => {
          reject(new Error(`${String(executable)} interrupted by ${signal}.`));
        });
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateProcessTree(child).finally(() => {
        resolve({
          exitCode: null,
          stdout: decodeBounded(stdout),
          stderr: decodeBounded(stderr),
          timedOut: true,
        });
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Uint8Array) => {
      appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode,
        stdout: decodeBounded(stdout),
        stderr: decodeBounded(stderr),
        timedOut: false,
      });
    });
  });
}

async function requireSuccessful(
  command: CommandInput,
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const result = await runCommand(command, cwd, timeoutMs);
  const [executable] = commandInvocation(command).argv;
  if (result.timedOut) throw new Error(`${String(executable)} timed out.`);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${String(executable)} exited with code ${String(result.exitCode)}${detail ? `: ${detail}` : "."}`,
    );
  }
  return result;
}

async function fetchRegistryVersion(packageName: string): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) },
  );
  if (!response.ok)
    throw new Error(`Registry lookup failed for ${packageName}: ${response.status}`);
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`Registry returned no version for ${packageName}.`);
  }
  return value.version;
}

export function resolveWindowsCmd(env: NodeJS.ProcessEnv = process.env): string {
  const cmd = resolveWindowsSystemExecutable("cmd.exe", env);
  if (!isExecutable(cmd)) throw new Error("Trusted Windows cmd.exe was not found.");
  return cmd;
}

export function buildProviderInvocation(
  binaryPath: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
  windowsCmdPath?: string,
): CommandInvocation {
  const extension = NodePath.extname(binaryPath).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { argv: [binaryPath, ...args] };
  }
  if ([binaryPath, ...args].some((value) => value.includes("\u0000") || /[%\r\n"]/u.test(value))) {
    throw new Error("Provider shim path or arguments cannot be represented safely for cmd.exe.");
  }
  const commandLine = `""${binaryPath}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
  return {
    argv: [windowsCmdPath ?? resolveWindowsCmd(), "/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

async function observeProvider(
  provider: ProviderCompatibilityName,
  repoRoot: string,
): Promise<ProviderObservation | null> {
  const definition = PROVIDER_COMPATIBILITY_MATRIX.providers[provider];
  const binaryPath = resolvePathCommand(provider === "codex" ? "codex" : "claude");
  if (!binaryPath) {
    console.warn(`[conformity] ${provider} is not installed on PATH; skipping it.`);
    return null;
  }
  let realBinaryPath = binaryPath;
  try {
    realBinaryPath = realpathSync.native(binaryPath);
  } catch {
    // The executable probe below remains authoritative when a shim cannot be
    // real-pathed (for example a package-manager indirection).
  }
  const versionResult = await requireSuccessful(
    buildProviderInvocation(binaryPath, ["--version"]),
    repoRoot,
    PROBE_TIMEOUT_MS,
  );
  const installedVersion = normalizeProviderVersionOutput(provider, versionResult.stdout);
  if (!installedVersion) throw new Error(`Could not decode ${provider} --version output.`);
  return {
    provider,
    binaryPath,
    installedVersion,
    registryVersion: await fetchRegistryVersion(definition.npmPackage).catch((error: unknown) => {
      console.warn(
        `[conformity] ${provider} registry version is unavailable; local approved-version checks remain authoritative. ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }),
    approvedVersion: definition.cliVersion,
    installKind: detectInstallKind(provider, [binaryPath, realBinaryPath], process.env),
  };
}

export function detectInstallKind(
  provider: ProviderCompatibilityName,
  commandPaths: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): ProviderObservation["installKind"] {
  const normalized = commandPaths.map((path) => path.replaceAll("\\", "/").toLowerCase());
  if (
    provider === "claude" &&
    normalized.some(
      (path) =>
        path.endsWith("/.local/bin/claude") ||
        path.endsWith("/.local/bin/claude.exe") ||
        path.includes("/.local/share/claude/"),
    )
  ) {
    return "native";
  }
  if (
    provider === "codex" &&
    normalized.some(
      (path) =>
        path.includes("/packages/standalone/") || path.includes("/programs/openai/codex/bin/"),
    )
  ) {
    return "standalone";
  }
  if (
    normalized.some(
      (path) =>
        path.includes("/cellar/") ||
        path.includes("/caskroom/") ||
        path.startsWith("/opt/homebrew/") ||
        path.startsWith("/home/linuxbrew/.linuxbrew/"),
    )
  ) {
    return "homebrew";
  }
  if (
    normalized.some(
      (path) =>
        path.includes("/.local/share/pnpm/") ||
        path.includes("/library/pnpm/") ||
        path.includes("/appdata/local/pnpm/") ||
        path.includes("/pnpm/global/"),
    )
  ) {
    return "pnpm";
  }
  const appData = env.APPDATA?.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.some(
      (path) =>
        path.includes("/lib/node_modules/") ||
        path.includes("/npm/node_modules/") ||
        (appData !== undefined && path.startsWith(`${appData}/npm/`)),
    )
  ) {
    return "npm";
  }
  return "unknown";
}

export function validateSourcePins(input: {
  readonly repoRoot: string;
  readonly readText?: (path: string) => string;
}): ReadonlyArray<string> {
  const readText = input.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const failures: string[] = [];
  const readRequired = (relativePath: string): string | null => {
    try {
      return readText(NodePath.join(input.repoRoot, relativePath));
    } catch (error) {
      failures.push(
        `${relativePath} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return null;
    }
  };
  const claude = PROVIDER_COMPATIBILITY_MATRIX.providers.claude;
  for (const relativePath of [
    "apps/server/package.json",
    "scripts/package.json",
    "packaging/desktop-runtime/package.json",
  ]) {
    const text = readRequired(relativePath);
    if (text === null) continue;
    let packageJson: { dependencies?: Record<string, string> };
    try {
      packageJson = JSON.parse(text) as { dependencies?: Record<string, string> };
    } catch (error) {
      failures.push(
        `${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
      continue;
    }
    if (packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"] !== claude.agentSdkVersion) {
      failures.push(`${relativePath} does not pin Agent SDK ${claude.agentSdkVersion}.`);
    }
  }
  const generatorPath = "packages/effect-codex-app-server/scripts/generate.ts";
  const generator = readRequired(generatorPath);
  if (
    generator !== null &&
    !generator.includes(PROVIDER_COMPATIBILITY_MATRIX.providers.codex.protocolRef)
  ) {
    failures.push("Codex generator ref does not match the compatibility matrix.");
  }
  const managedInstallerPath =
    "apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1";
  const managedInstaller = readRequired(managedInstallerPath);
  for (const provider of Object.values(PROVIDER_COMPATIBILITY_MATRIX.providers)) {
    const packageAndVersion = new RegExp(
      `^\\s*Install-ProviderPackage\\b[^\\r\\n]*-PackageName\\s+"${provider.npmPackage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"[^\\r\\n]*-Version\\s+"${provider.cliVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
      "mu",
    );
    if (managedInstaller !== null && !packageAndVersion.test(managedInstaller)) {
      failures.push(
        `Managed provider installer does not pair ${provider.npmPackage} with CLI ${provider.cliVersion}.`,
      );
    }
  }
  return failures;
}

async function observeAll(repoRoot: string): Promise<ReadonlyArray<ProviderObservation>> {
  const [codex, claude] = await Promise.all([
    observeProvider("codex", repoRoot),
    observeProvider("claude", repoRoot),
  ]);
  return [codex, claude].filter(
    (observation): observation is ProviderObservation => observation !== null,
  );
}

function providerNeedsUpdate(observation: ProviderObservation): boolean {
  return observation.installedVersion !== observation.approvedVersion;
}

async function runRepositoryGates(repoRoot: string): Promise<void> {
  const corepack = resolveCorepackCommand();
  const gates: ReadonlyArray<ReadonlyArray<string>> = [
    [...corepack, "yarn", "fmt:check"],
    [...corepack, "yarn", "lint"],
    [...corepack, "yarn", "typecheck"],
    [...corepack, "yarn", "test"],
    [...corepack, "yarn", "build:desktop"],
    [...corepack, "yarn", "providers:conform", "smoke"],
  ];
  for (const command of gates) {
    console.log(`[conformity] gate: ${command.join(" ")}`);
    await requireSuccessful(command, repoRoot, REPOSITORY_GATE_TIMEOUT_MS);
  }
}

export function resolveCorepackCommand(
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  if (platform === "win32") {
    const corepackJs = NodePath.join(
      NodePath.dirname(nodePath),
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );
    if (!isExecutable(corepackJs)) {
      throw new Error(`Could not resolve Corepack JavaScript entrypoint beside ${nodePath}.`);
    }
    return [nodePath, corepackJs];
  }
  const corepack = resolvePathCommand("corepack", process.env, platform);
  if (!corepack) throw new Error("Corepack is required for provider conformity gates.");
  return [corepack];
}

export function parseManifest(value: unknown): ProviderUpdateManifest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("repoRoot" in value) ||
    typeof value.repoRoot !== "string" ||
    !("commitSha" in value) ||
    typeof value.commitSha !== "string" ||
    !("projectDirectory" in value) ||
    typeof value.projectDirectory !== "string" ||
    !("logPath" in value) ||
    typeof value.logPath !== "string" ||
    !("attemptId" in value) ||
    typeof value.attemptId !== "string" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("providers" in value) ||
    !Array.isArray(value.providers)
  ) {
    throw new Error("Provider update manifest is invalid.");
  }
  const allowedInstallKinds = new Set([
    "native",
    "standalone",
    "npm",
    "pnpm",
    "homebrew",
    "unknown",
  ]);
  const providers = value.providers.map((provider): ProviderObservation => {
    if (
      typeof provider !== "object" ||
      provider === null ||
      !("provider" in provider) ||
      (provider.provider !== "codex" && provider.provider !== "claude") ||
      !("binaryPath" in provider) ||
      typeof provider.binaryPath !== "string" ||
      !NodePath.isAbsolute(provider.binaryPath) ||
      !("installedVersion" in provider) ||
      typeof provider.installedVersion !== "string" ||
      !("registryVersion" in provider) ||
      (provider.registryVersion !== null && typeof provider.registryVersion !== "string") ||
      !("approvedVersion" in provider) ||
      typeof provider.approvedVersion !== "string" ||
      !("installKind" in provider) ||
      typeof provider.installKind !== "string" ||
      !allowedInstallKinds.has(provider.installKind)
    ) {
      throw new Error("Provider update manifest contains an invalid provider observation.");
    }
    const providerName = provider.provider as ProviderCompatibilityName;
    const expected = PROVIDER_COMPATIBILITY_MATRIX.providers[providerName].cliVersion;
    if (
      provider.approvedVersion !== expected ||
      (provider.registryVersion !== null &&
        !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(provider.registryVersion)) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(provider.installedVersion)
    ) {
      throw new Error("Provider update manifest does not match the approved compatibility matrix.");
    }
    return {
      provider: providerName,
      binaryPath: provider.binaryPath,
      installedVersion: provider.installedVersion,
      registryVersion: provider.registryVersion,
      approvedVersion: provider.approvedVersion,
      installKind: provider.installKind as ProviderObservation["installKind"],
    };
  });
  if (
    providers.length < 1 ||
    providers.length > 2 ||
    new Set(providers.map(({ provider }) => provider)).size !== providers.length ||
    !/^[0-9]+-[0-9]+$/u.test(value.attemptId) ||
    !/^[0-9a-f]{40}$/u.test(value.commitSha) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !NodePath.isAbsolute(value.repoRoot) ||
    !NodePath.isAbsolute(value.projectDirectory) ||
    !NodePath.isAbsolute(value.logPath)
  ) {
    throw new Error("Provider update manifest is incomplete or ambiguous.");
  }
  return { ...value, providers } as ProviderUpdateManifest;
}

export function providerUpdateCommand(
  observation: ProviderObservation,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  windowsCmdExe?: string,
): CommandInput | null {
  if (!providerNeedsUpdate(observation)) return null;
  if (observation.provider === "codex" && observation.installKind === "standalone") {
    throw new Error(
      "Codex standalone update has no exact-version interface, so Cafe Code will not automate it. Install the approved standalone release manually or use an exact-version npm/pnpm layout.",
    );
  }
  if (observation.provider === "claude" && observation.installKind === "native") {
    return buildProviderInvocation(observation.binaryPath, [
      "install",
      observation.approvedVersion,
    ]);
  }
  const packageName = PROVIDER_COMPATIBILITY_MATRIX.providers[observation.provider].npmPackage;
  if (observation.installKind === "npm") {
    return [
      ...resolveNpmCommand(process.execPath, platform, env),
      "install",
      "-g",
      `${packageName}@${observation.approvedVersion}`,
    ];
  }
  if (observation.installKind === "pnpm") {
    const pnpm = resolvePathCommand("pnpm", env, platform);
    if (!pnpm) {
      throw new Error("pnpm is required to update this provider install.");
    }
    return buildProviderInvocation(
      pnpm,
      ["add", "-g", `${packageName}@${observation.approvedVersion}`],
      platform,
      windowsCmdExe,
    );
  }
  throw new Error(
    `${observation.provider} install type is not safely updatable by the detached helper. ` +
      "Use its package manager after Cafe Code publishes support for that install layout.",
  );
}

export function createUpdatePlan(observations: ReadonlyArray<ProviderObservation>): ReadonlyArray<{
  readonly observation: ProviderObservation;
  readonly command: CommandInput;
}> {
  const plan: Array<{ observation: ProviderObservation; command: CommandInput }> = [];
  const blocked: string[] = [];
  for (const observation of observations) {
    try {
      const command = providerUpdateCommand(observation);
      if (command !== null) plan.push({ observation, command });
    } catch (error) {
      if (providerNeedsUpdate(observation)) {
        blocked.push(
          `${observation.provider}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const message of blocked) {
    console.warn(`[conformity] manual action required: ${message}`);
  }
  if (plan.length === 0 && blocked.length > 0) {
    throw new Error(`No provider can be updated safely. ${blocked.join(" ")}`);
  }
  return plan;
}

export function resolveNpmCommand(
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<string> {
  if (platform === "win32") {
    const npmCli = NodePath.join(
      NodePath.dirname(nodePath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (!isExecutable(npmCli)) {
      throw new Error(`Could not resolve npm's JavaScript entrypoint beside ${nodePath}.`);
    }
    return [nodePath, npmCli];
  }
  const npm = resolvePathCommand("npm", env, platform);
  if (!npm) throw new Error("npm is required to update this provider install.");
  return [npm];
}

export function resolveWindowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const powershell = resolveWindowsSystemExecutable(
    String.raw`WindowsPowerShell\v1.0\powershell.exe`,
    env,
  );
  if (!isExecutable(powershell)) throw new Error("Trusted Windows PowerShell was not found.");
  return powershell;
}

function shortcutRepairCommand(repoRoot: string): ReadonlyArray<string> | null {
  if (process.platform !== "win32") return null;
  const script = NodePath.join(repoRoot, "scripts", "repair-cafe-code-shortcuts.ps1");
  if (!existsSync(script)) {
    console.warn(`[conformity] Shortcut repair skipped because the helper is missing: ${script}.`);
    return null;
  }
  const powershell = resolveWindowsPowerShell();
  return [
    powershell,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-RepoRoot",
    repoRoot,
  ];
}

async function repairWindowsShortcuts(
  command: ReadonlyArray<string> | null,
  repoRoot: string,
): Promise<void> {
  if (command === null) return;
  try {
    await requireSuccessful(command, repoRoot, SHORTCUT_REPAIR_TIMEOUT_MS);
  } catch (error) {
    console.warn(
      `[conformity] Shortcut repair failed; continuing with relaunch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function launchCommand(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<string> {
  if (platform === "win32") {
    const powershell = resolveWindowsPowerShell();
    const launcher = NodePath.join(repoRoot, "Start-CafeCode.ps1");
    if (!existsSync(launcher)) throw new Error(`Cafe Code launcher is missing: ${launcher}.`);
    return [
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcher,
      "-Wait",
    ];
  }
  if (platform === "linux" && env.APPIMAGE?.trim()) {
    const appImage = realpathSync.native(env.APPIMAGE.trim());
    if (
      !NodePath.isAbsolute(appImage) ||
      !appImage.endsWith(".AppImage") ||
      !isExecutable(appImage)
    ) {
      throw new Error(`Recorded Linux AppImage relaunch surface is invalid: ${appImage}.`);
    }
    return [appImage];
  }
  if (platform === "darwin" && env.CAFE_CODE_MACOS_APP_BUNDLE?.trim()) {
    const bundle = realpathSync.native(env.CAFE_CODE_MACOS_APP_BUNDLE.trim());
    const open = "/usr/bin/open";
    if (!NodePath.isAbsolute(bundle) || !bundle.endsWith(".app") || !existsSync(bundle)) {
      throw new Error(`Recorded macOS app relaunch surface is invalid: ${bundle}.`);
    }
    if (!isExecutable(open)) throw new Error("Trusted macOS open launcher is unavailable.");
    return [open, "-W", "-a", bundle];
  }
  const launcher = NodePath.join(repoRoot, "apps/desktop/scripts/start-electron.mjs");
  if (!existsSync(launcher)) throw new Error(`Cafe Code launcher is missing: ${launcher}.`);
  return [process.execPath, launcher];
}

async function spawnDetached(
  command: ReadonlyArray<string>,
  cwd: string,
  logPath?: string,
): Promise<number> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Cannot launch an empty command.");
  const stdout = logPath ? openSync(logPath, "a", 0o600) : null;
  const stderr = logPath ? openSync(logPath, "a", 0o600) : null;
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        detached: true,
        stdio: logPath ? ["ignore", stdout!, stderr!] : "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        const pid = child.pid;
        if (typeof pid !== "number") {
          reject(new Error(`Detached process ${executable} did not expose a pid.`));
          return;
        }
        child.unref();
        resolve(pid);
      });
    });
  } finally {
    if (stdout !== null) closeSync(stdout);
    if (stderr !== null) closeSync(stderr);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCafeCodeHealth(launcherPid: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let stableSince: number | null = null;
  while (Date.now() < deadline) {
    if (!processIsAlive(launcherPid)) {
      throw new Error(`Cafe Code launcher process ${launcherPid} exited during relaunch.`);
    }
    stableSince ??= Date.now();
    if (Date.now() - stableSince >= 10_000) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Cafe Code launcher process ${launcherPid} did not remain healthy.`);
}

async function showFallback(
  manifest: ProviderUpdateManifest,
  includeUpdateFailureLog = false,
): Promise<void> {
  const script = NodePath.join(manifest.repoRoot, "scripts", "provider-update-fallback.ts");
  if (!existsSync(script)) {
    throw new Error(`Provider recovery helper is missing: ${script}.`);
  }
  await spawnDetached(
    [
      process.execPath,
      script,
      "--project-dir",
      manifest.projectDirectory,
      "--claude",
      manifest.providers.find(({ provider }) => provider === "claude")?.binaryPath ?? "claude",
      "--codex",
      manifest.providers.find(({ provider }) => provider === "codex")?.binaryPath ?? "codex",
      "--mode",
      "recovery",
      ...(includeUpdateFailureLog ? ["--log", manifest.logPath] : []),
    ],
    manifest.projectDirectory,
    manifest.logPath,
  );
}

async function showUpdateFailureNotice(manifest: ProviderUpdateManifest): Promise<void> {
  const script = NodePath.join(manifest.repoRoot, "scripts", "provider-update-fallback.ts");
  await spawnDetached(
    [
      process.execPath,
      script,
      "--project-dir",
      manifest.projectDirectory,
      "--claude",
      manifest.providers.find(({ provider }) => provider === "claude")?.binaryPath ?? "claude",
      "--codex",
      manifest.providers.find(({ provider }) => provider === "codex")?.binaryPath ?? "codex",
      "--mode",
      "update-failed",
      "--log",
      manifest.logPath,
    ],
    manifest.projectDirectory,
    manifest.logPath,
  );
}

async function showShutdownFailureNotice(manifest: ProviderUpdateManifest): Promise<void> {
  const script = NodePath.join(manifest.repoRoot, "scripts", "provider-update-fallback.ts");
  await spawnDetached(
    [
      process.execPath,
      script,
      "--project-dir",
      manifest.projectDirectory,
      "--claude",
      manifest.providers.find(({ provider }) => provider === "claude")?.binaryPath ?? "claude",
      "--codex",
      manifest.providers.find(({ provider }) => provider === "codex")?.binaryPath ?? "codex",
      "--mode",
      "shutdown-failed",
      "--log",
      manifest.logPath,
    ],
    manifest.projectDirectory,
    manifest.logPath,
  );
}

export function killallProvedComplete(output: string): boolean {
  return (
    output.includes("No Cafe Code client/server processes found.") ||
    /Cafe Code killall targeted \d+ process\(es\); 0 failed or remained alive\./u.test(output)
  );
}

async function verifyRecordedProvider(observation: ProviderObservation, repoRoot: string) {
  const result = await requireSuccessful(
    buildProviderInvocation(observation.binaryPath, ["--version"]),
    repoRoot,
    PROBE_TIMEOUT_MS,
  );
  const version = normalizeProviderVersionOutput(observation.provider, result.stdout);
  if (version !== observation.installedVersion) {
    throw new Error(
      `${observation.provider} changed after conformity gates: expected ${observation.installedVersion}, found ${String(version)}. Update cancelled before shutdown.`,
    );
  }
}

async function runHelper(manifestPath: string): Promise<void> {
  const expectedHome = realpathSync.native(conformityHome());
  const expectedRepoRoot = realpathSync.native(
    NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const canonicalManifestPath = realpathSync.native(manifestPath);
  const manifestDirectory = NodePath.dirname(canonicalManifestPath);
  if (manifestDirectory !== expectedHome) {
    throw new Error("Provider update manifest is outside the Cafe conformity state directory.");
  }
  const manifest = parseManifest(
    JSON.parse(readFileSync(canonicalManifestPath, "utf8")) as unknown,
  );
  if (realpathSync.native(manifest.repoRoot) !== expectedRepoRoot) {
    throw new Error("Provider update manifest names a different Cafe Code checkout.");
  }
  if (NodePath.dirname(realpathSync.native(manifest.logPath)) !== expectedHome) {
    throw new Error("Provider update log is outside the Cafe conformity state directory.");
  }
  const sourceFailures = validateSourcePins({ repoRoot: manifest.repoRoot });
  if (sourceFailures.length > 0) {
    throw new Error(
      `Provider update source pins changed after the detached helper was scheduled: ${sourceFailures.join(" ")}`,
    );
  }
  if (!manifest.providers.every(({ binaryPath }) => isExecutable(binaryPath))) {
    throw new Error("A recorded provider executable is no longer available.");
  }
  const canonicalProjectDirectory = realpathSync.native(manifest.projectDirectory);
  assertRecoveryProjectOutsideRepo(expectedRepoRoot, canonicalProjectDirectory);
  if (
    (await gitOutput(manifest.repoRoot, ["rev-parse", "HEAD"])) !== manifest.commitSha ||
    (await gitOutput(manifest.repoRoot, ["status", "--porcelain"])) !== ""
  ) {
    throw new Error(
      "Cafe Code source changed after conformity gates; update cancelled before shutdown.",
    );
  }
  const launch = launchCommand(manifest.repoRoot);
  const shortcutRepair = shortcutRepairCommand(manifest.repoRoot);
  if (!existsSync(NodePath.join(manifest.repoRoot, "scripts", "provider-update-fallback.ts"))) {
    throw new Error("Provider recovery helper is unavailable; update cancelled before shutdown.");
  }
  for (const observation of manifest.providers) {
    await verifyRecordedProvider(observation, manifest.repoRoot);
  }
  const updatePlan = createUpdatePlan(manifest.providers);
  // Consume the one-shot capability before any state-changing action. A stale
  // attempt file can no longer be replayed after this validation point.
  unlinkSync(canonicalManifestPath);
  await new Promise<void>((resolve) => setTimeout(resolve, HELPER_WAIT_MS));
  let updateFailure: unknown = null;
  try {
    const shutdown = await requireSuccessful(
      [process.execPath, "apps/server/src/bin.ts", "killall"],
      manifest.repoRoot,
      SHUTDOWN_TIMEOUT_MS,
    );
    if (!killallProvedComplete(shutdown.stdout)) {
      throw new Error(`Cafe Code shutdown did not prove completion. ${shutdown.stdout.trim()}`);
    }
  } catch (error) {
    const shutdownFailure = new Error(
      `Cafe Code shutdown did not complete cleanly; provider installation was not attempted: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    console.error(`[conformity] ${shutdownFailure.message}`);
    try {
      await showShutdownFailureNotice(manifest);
    } catch (noticeError) {
      console.error(
        `[conformity] Shutdown-failure notice could not be displayed; do not launch a second Cafe Code instance until remaining processes are stopped. ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  try {
    for (const { observation, command } of updatePlan) {
      await requireSuccessful(command, manifest.repoRoot);
      const verified = await requireSuccessful(
        buildProviderInvocation(observation.binaryPath, ["--version"]),
        manifest.repoRoot,
        PROBE_TIMEOUT_MS,
      );
      const version = normalizeProviderVersionOutput(observation.provider, verified.stdout);
      if (version !== observation.approvedVersion) {
        throw new Error(
          `${observation.provider} verification failed: expected ${observation.approvedVersion}, found ${String(version)}.`,
        );
      }
    }
  } catch (error) {
    updateFailure = error;
  }
  if (updateFailure !== null) {
    console.error(
      `[conformity] Provider update failed; attempting to restore Cafe Code first: ${updateFailure instanceof Error ? updateFailure.message : String(updateFailure)}`,
    );
  }

  await repairWindowsShortcuts(shortcutRepair, manifest.repoRoot);
  try {
    const launcherPid = await spawnDetached(launch, manifest.repoRoot);
    await waitForCafeCodeHealth(launcherPid);
    console.log(
      `[conformity] Cafe Code relaunched through checkout-bound process ${launcherPid} and remained alive through the bounded health window.`,
    );
  } catch (error) {
    console.error(
      `[conformity] Cafe Code relaunch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await showFallback(manifest, updateFailure !== null);
    } catch (fallbackError) {
      console.error(
        `[conformity] Recovery notice could not be displayed; open Claude Code or Codex manually from ${manifest.projectDirectory}. ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  if (updateFailure !== null) {
    try {
      await showUpdateFailureNotice(manifest);
    } catch (noticeError) {
      console.error(
        `[conformity] Cafe Code restarted, but the update-failure notice could not open: ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`,
      );
    }
    process.exitCode = 1;
  }
}

function conformityHome(): string {
  return NodePath.join(
    process.env.CAFE_CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".cafe-code"),
    "provider-updates",
  );
}

function prepareConformityHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(home, 0o700);
  const attempts = new Map<string, { paths: string[]; modifiedAt: number }>();
  for (const name of readdirSync(home)) {
    const match = /^(attempt-\d+-\d+)\.(?:json|log)$/u.exec(name);
    if (!match?.[1]) continue;
    const path = NodePath.join(home, name);
    try {
      const modifiedAt = statSync(path).mtimeMs;
      const attempt = attempts.get(match[1]) ?? { paths: [], modifiedAt };
      attempt.paths.push(path);
      attempt.modifiedAt = Math.max(attempt.modifiedAt, modifiedAt);
      attempts.set(match[1], attempt);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  // Leave room for the attempt about to be written, keeping at most twenty
  // complete attempt groups after this function returns to writeManifest.
  const stale = [...attempts.values()]
    .toSorted((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(19);
  for (const { paths } of stale) {
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

function writeManifest(input: {
  readonly repoRoot: string;
  readonly commitSha: string;
  readonly projectDirectory: string;
  readonly providers: ReadonlyArray<ProviderObservation>;
}): { readonly manifest: ProviderUpdateManifest; readonly manifestPath: string } {
  const attemptId = `${Date.now()}-${process.pid}`;
  const home = conformityHome();
  prepareConformityHome(home);
  const manifestPath = NodePath.join(home, `attempt-${attemptId}.json`);
  const manifest: ProviderUpdateManifest = {
    schemaVersion: 1,
    attemptId,
    createdAt: new Date().toISOString(),
    repoRoot: input.repoRoot,
    commitSha: input.commitSha,
    projectDirectory: input.projectDirectory,
    logPath: NodePath.join(home, `attempt-${attemptId}.log`),
    providers: input.providers,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { manifest, manifestPath };
}

async function scheduleHelper(
  manifest: ProviderUpdateManifest,
  manifestPath: string,
): Promise<void> {
  const stdout = openSync(manifest.logPath, "a", 0o600);
  const stderr = openSync(manifest.logPath, "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const helper = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "helper", "--manifest", manifestPath],
        {
          cwd: manifest.repoRoot,
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", stdout, stderr],
        },
      );
      helper.once("error", reject);
      helper.once("spawn", () => {
        helper.unref();
        resolve();
      });
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

async function gitOutput(repoRoot: string, args: ReadonlyArray<string>): Promise<string> {
  return (await requireSuccessful(["git", ...args], repoRoot, PROBE_TIMEOUT_MS)).stdout.trim();
}

export function normalizeGitHubRepository(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/u, "");
  const match = trimmed.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/u,
  );
  return match?.[1] ? validateGitHubRepositoryName(match[1]) : null;
}

export function validateGitHubRepositoryName(value: string): string | null {
  const parts = value.trim().split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(part),
    )
  ) {
    return null;
  }
  return parts.join("/");
}

async function githubRepositoryForRemote(repoRoot: string, remote: string): Promise<string> {
  const remoteUrl = await gitOutput(repoRoot, ["remote", "get-url", remote]);
  const repository = normalizeGitHubRepository(remoteUrl);
  if (!repository) throw new Error(`${remote} is not a recognized GitHub repository remote.`);
  return repository;
}

async function optionalGitHubRepositoryForRemote(
  repoRoot: string,
  remote: string,
): Promise<string | null> {
  const result = await runCommand(["git", "remote", "get-url", remote], repoRoot, PROBE_TIMEOUT_MS);
  if (result.timedOut) throw new Error(`Timed out resolving Git remote ${remote}.`);
  if (result.exitCode !== 0) return null;
  const repository = normalizeGitHubRepository(result.stdout);
  if (!repository) throw new Error(`${remote} is not a recognized GitHub repository remote.`);
  return repository;
}

async function publish(
  repoRoot: string,
  waitForCi: boolean,
  requestedBaseBranch?: string,
  requestedTargetRepo?: string,
): Promise<void> {
  const branch = await gitOutput(repoRoot, ["branch", "--show-current"]);
  if (!branch.startsWith("provider-conformity/")) {
    throw new Error("Publication requires a focused provider-conformity/* branch.");
  }
  if ((await gitOutput(repoRoot, ["status", "--porcelain"])) !== "") {
    throw new Error("Commit intentionally and leave a clean worktree before publication.");
  }
  const sourceFailures = validateSourcePins({ repoRoot });
  if (sourceFailures.length > 0) throw new Error(sourceFailures.join(" "));
  const originRepo = await githubRepositoryForRemote(repoRoot, "origin");
  const targetRepo = requestedTargetRepo
    ? validateGitHubRepositoryName(requestedTargetRepo)
    : ((await optionalGitHubRepositoryForRemote(repoRoot, "upstream")) ?? originRepo);
  if (!targetRepo) {
    throw new Error(`Invalid GitHub target repository: ${String(requestedTargetRepo)}.`);
  }
  const originOwner = originRepo.split("/")[0];
  if (!originOwner) throw new Error("Could not determine the fork owner for the PR head.");
  if (originRepo !== targetRepo) {
    const parentRepository = (
      await requireSuccessful(
        ["gh", "api", `repos/${originRepo}`, "--jq", '.parent.full_name // ""'],
        repoRoot,
        PROBE_TIMEOUT_MS,
      )
    ).stdout.trim();
    if (parentRepository.toLowerCase() !== targetRepo.toLowerCase()) {
      throw new Error(
        `Origin ${originRepo} is not a direct fork of target ${targetRepo}; publication refused.`,
      );
    }
  }
  const baseBranch =
    requestedBaseBranch ??
    (
      await requireSuccessful(
        [
          "gh",
          "repo",
          "view",
          targetRepo,
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name",
        ],
        repoRoot,
        PROBE_TIMEOUT_MS,
      )
    ).stdout.trim();
  if (!/^[A-Za-z0-9._/-]+$/u.test(baseBranch)) {
    throw new Error(`Invalid GitHub base branch: ${baseBranch}.`);
  }
  await requireSuccessful(
    ["gh", "api", `repos/${targetRepo}/branches/${encodeURIComponent(baseBranch)}`],
    repoRoot,
    PROBE_TIMEOUT_MS,
  );
  await runRepositoryGates(repoRoot);
  if ((await gitOutput(repoRoot, ["status", "--porcelain"])) !== "") {
    throw new Error("A conformity gate changed the worktree; review and commit the effect first.");
  }
  const head = `${originOwner}:${branch}`;

  const existing = await requireSuccessful(
    [
      "gh",
      "api",
      "--method",
      "GET",
      `repos/${targetRepo}/pulls`,
      "-f",
      `head=${head}`,
      "-f",
      `base=${baseBranch}`,
      "-f",
      "state=open",
      "--jq",
      '.[0].html_url // ""',
    ],
    repoRoot,
    PROBE_TIMEOUT_MS,
  );
  await requireSuccessful(["git", "push", "--set-upstream", "origin", "HEAD"], repoRoot);
  let prReference = existing.stdout.trim();
  if (!prReference) {
    const title = `Conform providers: Claude ${PROVIDER_COMPATIBILITY_MATRIX.providers.claude.cliVersion}, Codex ${PROVIDER_COMPATIBILITY_MATRIX.providers.codex.cliVersion}`;
    const evidence = [
      "## Provider compatibility evidence",
      "",
      `- Claude Code: \`${PROVIDER_COMPATIBILITY_MATRIX.providers.claude.cliVersion}\``,
      `- Claude Agent SDK: \`${PROVIDER_COMPATIBILITY_MATRIX.providers.claude.agentSdkVersion}\``,
      `- Codex CLI: \`${PROVIDER_COMPATIBILITY_MATRIX.providers.codex.cliVersion}\``,
      `- Codex protocol ref: \`${PROVIDER_COMPATIBILITY_MATRIX.providers.codex.protocolRef}\``,
      "- Local required gates: passed through `yarn providers:conform publish`",
      "- Merge remains blocked on the repository's macOS, Linux, Windows, and Arch checks.",
    ].join("\n");
    const template = readFileSync(
      NodePath.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE", "provider-conformity.md"),
      "utf8",
    ).trim();
    const body = `${evidence}\n\n${template}`;
    prReference = (
      await requireSuccessful(
        [
          "gh",
          "pr",
          "create",
          "--repo",
          targetRepo,
          "--draft",
          "--base",
          baseBranch,
          "--head",
          head,
          "--title",
          title,
          "--body",
          body,
        ],
        repoRoot,
      )
    ).stdout.trim();
    if (!prReference) {
      throw new Error("GitHub created the conformity PR but returned no reference.");
    }
  } else {
    console.log(`[conformity] reusing ${prReference}`);
  }
  if (waitForCi) {
    await requireSuccessful(
      ["gh", "pr", "checks", prReference, "--watch", "--fail-fast", "--interval", "20"],
      repoRoot,
      GITHUB_CI_TIMEOUT_MS,
    );
    await requireSuccessful(
      ["gh", "pr", "ready", prReference],
      repoRoot,
      GITHUB_MUTATION_TIMEOUT_MS,
    );
  }
}

async function main(): Promise<void> {
  const args = parseProviderConformityArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  const repoRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
  if (args.command === "helper") {
    if (!args.manifestPath) throw new Error("helper requires --manifest.");
    await runHelper(NodePath.resolve(args.manifestPath));
    return;
  }

  const sourceFailures = validateSourcePins({ repoRoot });
  if (sourceFailures.length > 0) throw new Error(sourceFailures.join(" "));
  if (args.command === "smoke") {
    console.log("Provider conformity source pins are internally consistent.");
    return;
  }

  if (args.command === "publish") {
    await publish(repoRoot, args.waitForCi, args.baseBranch, args.targetRepo);
    return;
  }

  const observations = await observeAll(repoRoot);
  if (observations.length === 0) {
    throw new Error("Neither Claude Code nor Codex is installed on PATH.");
  }
  for (const observation of observations) {
    console.log(
      `${observation.provider}: installed=${observation.installedVersion} approved=${observation.approvedVersion} upstream=${observation.registryVersion}`,
    );
  }
  if (args.command === "check") return;
  createUpdatePlan(observations);
  const pendingUpdates = observations.filter(providerNeedsUpdate);
  if (pendingUpdates.length === 0) {
    console.log("All installed provider CLIs already match the approved compatibility matrix.");
    return;
  }
  const projectDirectory = realpathSync.native(
    selectRecoveryProjectDirectory(args.projectDirectory, process.env.INIT_CWD),
  );
  assertRecoveryProjectOutsideRepo(realpathSync.native(repoRoot), projectDirectory);
  if (args.dryRun) {
    console.log(
      `Provider conformity update dry run passed for ${pendingUpdates.map(({ provider }) => provider).join(", ")}; Cafe Code remains running.`,
    );
    return;
  }
  if ((await gitOutput(repoRoot, ["status", "--porcelain"])) !== "") {
    throw new Error(
      "Provider update requires a clean Cafe Code checkout so the tested build is reproducible.",
    );
  }
  await runRepositoryGates(repoRoot);
  if ((await gitOutput(repoRoot, ["status", "--porcelain"])) !== "") {
    throw new Error("A conformity gate changed the worktree; update cancelled before shutdown.");
  }
  const commitSha = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  const { manifest, manifestPath } = writeManifest({
    repoRoot,
    commitSha,
    projectDirectory,
    providers: observations,
  });
  await scheduleHelper(manifest, manifestPath);
  console.log(`Provider update scheduled. Recovery log: ${manifest.logPath}`);
}

function isExecutedAsMainModule(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  try {
    return realpathSync.native(entryPoint) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedAsMainModule()) {
  main().catch((error: unknown) => {
    console.error(`[conformity] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
