import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as Electron from "electron";

import { auditPackagedDesktopArtifact } from "./DesktopArtifactAudit.ts";

export const DESKTOP_RUNTIME_SELF_TEST_SWITCH = "--cafe-runtime-self-test";
export const DESKTOP_RUNTIME_SELF_TEST_RESULT_ENV = "CAFE_CODE_RUNTIME_SELF_TEST_RESULT";
export const DESKTOP_RUNTIME_SELF_TEST_OUTPUT_PREFIX = "CAFE_CODE_RUNTIME_SELF_TEST=";

const PTY_TIMEOUT_MS = 10_000;

export interface DesktopRuntimeSelfTestDependencies {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly whenReady: () => Promise<void>;
  readonly safeStorageRoundTrip: () => Promise<boolean>;
  readonly sqliteRoundTrip: () => Promise<boolean>;
  readonly ptyRoundTrip: () => Promise<boolean>;
  readonly packagedResourcesPresent: () => Promise<boolean>;
  readonly packagedArtifactAudit: () => Promise<boolean>;
  readonly updateMetadataPresent: () => Promise<boolean>;
  readonly managedRuntimePresent: () => Promise<boolean | null>;
}

export interface DesktopRuntimeSelfTestResult {
  readonly ok: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly checks: {
    readonly safeStorage: boolean;
    readonly sqlite: boolean;
    readonly pty: boolean;
    readonly packagedResources: boolean;
    readonly packagedArtifactAudit: boolean;
    readonly updateMetadata: boolean;
    readonly managedRuntime: boolean | null;
  };
  readonly failedChecks: readonly string[];
}

export function isDesktopRuntimeSelfTestEnabled(argv: readonly string[] = process.argv): boolean {
  return argv.includes(DESKTOP_RUNTIME_SELF_TEST_SWITCH);
}

async function runPtyRoundTrip(): Promise<boolean> {
  const { spawn } = await import("node-pty");
  const marker = `cafecode-pty-${randomUUID()}`;
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", `echo ${marker}`]
      : ["-lc", `printf '%s\\n' '${marker}'`];
  const terminal = spawn(executable, args, {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
  });

  return await new Promise<boolean>((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      dataDisposable.dispose();
      exitDisposable.dispose();
      resolve(result);
    };
    const dataDisposable = terminal.onData((chunk) => {
      output += chunk;
    });
    const exitDisposable = terminal.onExit(({ exitCode }) => {
      finish(exitCode === 0 && output.includes(marker));
    });
    const timeout = setTimeout(() => {
      terminal.kill();
      finish(false);
    }, PTY_TIMEOUT_MS);
  });
}

async function runSqliteRoundTrip(): Promise<boolean> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE self_test (value TEXT NOT NULL)");
    database.prepare("INSERT INTO self_test (value) VALUES (?)").run("ready");
    const row = database.prepare("SELECT value FROM self_test").get() as
      | { readonly value?: unknown }
      | undefined;
    return row?.value === "ready";
  } finally {
    database.close();
  }
}

async function runSafeStorageRoundTrip(): Promise<boolean> {
  if (!Electron.safeStorage.isEncryptionAvailable()) return false;
  const value = `cafecode-safe-storage-${randomUUID()}`;
  const encrypted = Electron.safeStorage.encryptString(value);
  return encrypted.length > 0 && Electron.safeStorage.decryptString(encrypted) === value;
}

function makeRealDependencies(): DesktopRuntimeSelfTestDependencies {
  const isPackaged = Electron.app.isPackaged;
  const resourcesPath = process.resourcesPath;
  const managedRuntimeRoot = join(resourcesPath, "managed-runtime");
  const managedRuntimeArch = process.arch === "arm64" ? "win-arm64" : "win-x64";

  return {
    platform: process.platform,
    arch: process.arch,
    isPackaged,
    whenReady: () => Electron.app.whenReady(),
    safeStorageRoundTrip: runSafeStorageRoundTrip,
    sqliteRoundTrip: runSqliteRoundTrip,
    ptyRoundTrip: runPtyRoundTrip,
    packagedResourcesPresent: async () =>
      !isPackaged || existsSync(join(resourcesPath, "app.asar")),
    packagedArtifactAudit: async () =>
      !isPackaged || auditPackagedDesktopArtifact(resourcesPath, process.platform),
    updateMetadataPresent: async () =>
      !isPackaged ||
      process.platform === "linux" ||
      existsSync(join(resourcesPath, "app-update.yml")),
    managedRuntimePresent: async () => {
      if (!isPackaged || process.platform !== "win32") return null;
      return [
        join(managedRuntimeRoot, "install-managed-provider-runtime.ps1"),
        join(managedRuntimeRoot, "node", managedRuntimeArch, "node.exe"),
        join(managedRuntimeRoot, "node", managedRuntimeArch, "npm.cmd"),
      ].every(existsSync);
    },
  };
}

async function runBooleanCheck(action: () => Promise<boolean>): Promise<boolean> {
  try {
    return await action();
  } catch {
    return false;
  }
}

export async function collectDesktopRuntimeSelfTestResult(
  dependencies: DesktopRuntimeSelfTestDependencies,
): Promise<DesktopRuntimeSelfTestResult> {
  await dependencies.whenReady();
  const [
    safeStorage,
    sqlite,
    pty,
    packagedResources,
    packagedArtifactAudit,
    updateMetadata,
    managedRuntime,
  ] = await Promise.all([
    runBooleanCheck(dependencies.safeStorageRoundTrip),
    runBooleanCheck(dependencies.sqliteRoundTrip),
    runBooleanCheck(dependencies.ptyRoundTrip),
    runBooleanCheck(dependencies.packagedResourcesPresent),
    runBooleanCheck(dependencies.packagedArtifactAudit),
    runBooleanCheck(dependencies.updateMetadataPresent),
    dependencies.managedRuntimePresent().catch(() => false),
  ]);
  const failedChecks = [
    safeStorage ? null : "safeStorage",
    sqlite ? null : "sqlite",
    pty ? null : "pty",
    packagedResources ? null : "packagedResources",
    packagedArtifactAudit ? null : "packagedArtifactAudit",
    updateMetadata ? null : "updateMetadata",
    managedRuntime === false ? "managedRuntime" : null,
  ].filter((value): value is string => value !== null);

  return {
    ok: failedChecks.length === 0,
    platform: dependencies.platform,
    arch: dependencies.arch,
    isPackaged: dependencies.isPackaged,
    checks: {
      safeStorage,
      sqlite,
      pty,
      packagedResources,
      packagedArtifactAudit,
      updateMetadata,
      managedRuntime,
    },
    failedChecks,
  };
}

export async function runDesktopRuntimeSelfTestAndExit(): Promise<void> {
  let result: DesktopRuntimeSelfTestResult;
  try {
    result = await collectDesktopRuntimeSelfTestResult(makeRealDependencies());
  } catch {
    result = {
      ok: false,
      platform: process.platform,
      arch: process.arch,
      isPackaged: Electron.app.isPackaged,
      checks: {
        safeStorage: false,
        sqlite: false,
        pty: false,
        packagedResources: false,
        packagedArtifactAudit: false,
        updateMetadata: false,
        managedRuntime: process.platform === "win32" ? false : null,
      },
      failedChecks: ["bootstrap"],
    };
  }

  const encoded = `${JSON.stringify(result)}\n`;
  const resultPath = process.env[DESKTOP_RUNTIME_SELF_TEST_RESULT_ENV]?.trim();
  if (resultPath) {
    try {
      await writeFile(resultPath, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch {
      result = { ...result, ok: false, failedChecks: [...result.failedChecks, "resultFile"] };
    }
  }

  console.info(`${DESKTOP_RUNTIME_SELF_TEST_OUTPUT_PREFIX}${JSON.stringify(result)}`);
  Electron.app.exit(result.ok ? 0 : 1);
}
