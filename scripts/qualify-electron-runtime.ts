#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is an explicit native qualification command, not part of the ordinary
// unit-test graph. Synchronizing package declarations alone cannot detect a
// stale/skipped Electron download. Invoke the executable resolved from the
// desktop workspace and verify its own runtime report instead.
const REVIEWED_ELECTRON_VERSION = "42.10.0";
const REVIEWED_NODE_FLOOR = [24, 18, 1] as const;
const REVIEWED_NATIVE_ABI = "146";
const PROCESS_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 4096;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const RUNTIME_REPORT_SCRIPT =
  "process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,modules:process.versions.modules})+'\\n')";

interface ElectronPins {
  readonly desktop: unknown;
  readonly server: unknown;
  readonly packaging: unknown;
}

export interface ElectronRuntimeReport {
  readonly electron: string;
  readonly node: string;
  readonly modules: string;
}

// Only fixed, Cafe-authored diagnostics are printed. Native loader failures or
// filesystem exceptions can contain unrestricted paths; neither is forwarded
// to the terminal through a cause, stderr dump, or an exception stack.
class ElectronQualificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElectronQualificationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validateElectronQualificationPins(pins: ElectronPins): string {
  // The explicit reviewed release also prevents three matching but older pins
  // from accidentally passing the security-upgrade gate. Future upgrades must
  // review the bundled Node and ABI before updating this qualification tuple.
  if (
    [pins.desktop, pins.server, pins.packaging].some((pin) => pin !== REVIEWED_ELECTRON_VERSION)
  ) {
    throw new ElectronQualificationError(
      "All three Electron declarations must match the reviewed 42.10.0 release.",
    );
  }
  return REVIEWED_ELECTRON_VERSION;
}

export function validateElectronRuntimeReport(stdout: string): ElectronRuntimeReport {
  if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT_BYTES) {
    throw new ElectronQualificationError("Electron runtime report exceeded its output limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ElectronQualificationError("Electron did not produce one valid JSON runtime report.");
  }
  const report = asRecord(value);
  if (
    report === undefined ||
    Object.keys(report).length !== 3 ||
    typeof report.electron !== "string" ||
    typeof report.node !== "string" ||
    typeof report.modules !== "string"
  ) {
    throw new ElectronQualificationError("Electron runtime report has an invalid shape.");
  }
  if (report.electron !== REVIEWED_ELECTRON_VERSION) {
    throw new ElectronQualificationError("Installed Electron does not match the reviewed release.");
  }
  const nodeVersion = VERSION_PATTERN.exec(report.node);
  const major = Number(nodeVersion?.[1]);
  const minor = Number(nodeVersion?.[2]);
  const patch = Number(nodeVersion?.[3]);
  if (
    nodeVersion === null ||
    ![major, minor, patch].every(Number.isSafeInteger) ||
    major !== REVIEWED_NODE_FLOOR[0] ||
    minor < REVIEWED_NODE_FLOOR[1] ||
    (minor === REVIEWED_NODE_FLOOR[1] && patch < REVIEWED_NODE_FLOOR[2])
  ) {
    throw new ElectronQualificationError("Bundled Node must remain Node 24 at or above 24.18.1.");
  }
  if (report.modules !== REVIEWED_NATIVE_ABI) {
    throw new ElectronQualificationError("Installed Electron has an unqualified native addon ABI.");
  }
  return { electron: report.electron, node: report.node, modules: report.modules };
}

export function electronQualificationEnvironment(
  inherited: NodeJS.ProcessEnv,
  isolatedRoot: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!isAbsolute(isolatedRoot)) {
    throw new ElectronQualificationError(
      "Electron qualification requires an absolute temporary root.",
    );
  }
  // Do not spread the parent environment: NODE_OPTIONS, loader injection,
  // provider auth homes/tokens and real desktop profiles must never enter this
  // check. The native executable is absolute, so inherited PATH is unnecessary.
  // These overrides are test-only; production provider environments stay intact.
  const home = join(isolatedRoot, "home");
  const environment: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: "1",
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(isolatedRoot, "config"),
    LOCALAPPDATA: join(isolatedRoot, "local"),
    XDG_CONFIG_HOME: join(isolatedRoot, "config"),
    XDG_CACHE_HOME: join(isolatedRoot, "cache"),
    XDG_DATA_HOME: join(isolatedRoot, "data"),
    TMP: join(isolatedRoot, "temp"),
    TEMP: join(isolatedRoot, "temp"),
    TMPDIR: join(isolatedRoot, "temp"),
  };
  if (platform === "win32") {
    // Windows native startup can require its system-directory variables. Names
    // are case-insensitive there; publish one canonical spelling and never
    // carry arbitrary inherited variables or duplicate PATH/Node-hook aliases.
    for (const name of ["SystemRoot", "WINDIR"]) {
      const entry = Object.entries(inherited).find(
        ([key, value]) => value !== undefined && key.toLowerCase() === name.toLowerCase(),
      );
      if (entry?.[1] !== undefined) environment[name] = entry[1];
    }
  }
  return environment;
}

export function resolveElectronQualificationExecutable(
  packageRoot: string,
  installedRelativePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const nativeRelativePath =
    platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : platform === "win32"
        ? "electron.exe"
        : platform === "linux"
          ? "electron"
          : undefined;
  // Electron's index.js accepts ELECTRON_OVERRIDE_DIST_PATH and can initiate a
  // download when a binary is missing. Resolving its package.json and reading
  // this strict path.txt metadata avoids both behaviors: qualification must
  // observe the existing installed binary, not repair or select another one.
  if (
    !isAbsolute(packageRoot) ||
    nativeRelativePath === undefined ||
    installedRelativePath !== nativeRelativePath
  ) {
    throw new ElectronQualificationError(
      "Installed Electron executable metadata is not qualified.",
    );
  }
  return join(packageRoot, "dist", nativeRelativePath);
}

export function isElectronQualificationEntryPoint(
  moduleUrl: string,
  scriptPath: string | undefined,
): boolean {
  // fileURLToPath handles escaped spaces and native drive letters. Comparing a
  // URL pathname to argv would silently miss direct execution on Windows.
  return scriptPath !== undefined && fileURLToPath(moduleUrl) === resolve(scriptPath);
}

async function readPackageElectronPin(relativePath: string, section: string): Promise<unknown> {
  const contents = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return asRecord(asRecord(JSON.parse(contents))?.[section])?.electron;
}

export async function qualifyInstalledElectronRuntime(): Promise<ElectronRuntimeReport> {
  const [desktop, server, packaging] = await Promise.all([
    readPackageElectronPin("../apps/desktop/package.json", "dependencies"),
    readPackageElectronPin("../apps/server/package.json", "dependencies"),
    readPackageElectronPin("../packaging/desktop-runtime/package.json", "devDependencies"),
  ]);
  validateElectronQualificationPins({ desktop, server, packaging });
  const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const packageFile = desktopRequire.resolve("electron/package.json");
  const packageRoot = dirname(packageFile);
  if (
    asRecord(JSON.parse(await readFile(packageFile, "utf8")))?.version !== REVIEWED_ELECTRON_VERSION
  ) {
    throw new ElectronQualificationError(
      "The desktop-installed Electron package does not match its declaration.",
    );
  }
  const metadataFile = join(packageRoot, "path.txt");
  const metadataStat = await lstat(metadataFile);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new ElectronQualificationError(
      "Installed Electron executable metadata is not a regular file.",
    );
  }
  const executable = resolveElectronQualificationExecutable(
    packageRoot,
    await readFile(metadataFile, "utf8"),
  );
  const executableStat = await lstat(executable);
  if (
    !executableStat.isFile() ||
    executableStat.isSymbolicLink() ||
    (process.platform !== "win32" && (executableStat.mode & 0o111) === 0)
  ) {
    throw new ElectronQualificationError(
      "Electron qualification requires a regular native executable.",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "cafecode-electron-qualification-"));
  try {
    await Promise.all(
      ["home", "config", "local", "cache", "data", "temp"].map((name) =>
        mkdir(join(temporaryRoot, name), { mode: 0o700 }),
      ),
    );
    const stdout = await new Promise<string>((resolveReport, rejectReport) => {
      // Run only a fixed version-report expression, with no Cafe entrypoint,
      // provider process, user profile, GPU/display flags or sandbox overrides.
      // execFile bounds BOTH stdout and stderr and calls back after child close,
      // allowing safe scoped-directory cleanup only after stdio has drained.
      execFile(
        executable,
        ["--eval", RUNTIME_REPORT_SCRIPT],
        {
          cwd: temporaryRoot,
          env: electronQualificationEnvironment(process.env, temporaryRoot),
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: PROCESS_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: OUTPUT_LIMIT_BYTES,
        },
        (error, capturedStdout) => {
          if (error !== null) {
            rejectReport(
              new ElectronQualificationError(
                "Electron version probe failed or exceeded its time/output bounds.",
              ),
            );
          } else {
            resolveReport(capturedStdout);
          }
        },
      );
    });
    return validateElectronRuntimeReport(stdout);
  } finally {
    // This exact mkdtemp result is the only removal target; no ambient profile
    // or unresolved environment variable participates in recursive cleanup.
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (isElectronQualificationEntryPoint(import.meta.url, process.argv[1])) {
  try {
    const report = await qualifyInstalledElectronRuntime();
    process.stdout.write(
      `Qualified installed Electron ${report.electron}; bundled Node ${report.node}; native ABI ${report.modules}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof ElectronQualificationError ? error.message : "Installed Electron qualification failed before a valid runtime report."}\n`,
    );
    process.exitCode = 1;
  }
}
