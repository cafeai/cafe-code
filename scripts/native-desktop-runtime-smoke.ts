import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

import { readJsonFile } from "./json-file.ts";

const SELF_TEST_SWITCH = "--cafe-runtime-self-test";
const SELF_TEST_RESULT_ENV = "CAFE_CODE_RUNTIME_SELF_TEST_RESULT";
const DISABLE_CHROMIUM_SANDBOX_ENV = "CAFE_CODE_NATIVE_SMOKE_DISABLE_CHROMIUM_SANDBOX";
const ENVIRONMENT_ENDPOINT_PATH = "/.well-known/cafe-code/environment";
const DEBUG_URL_PATTERN = /\[Cafe Code debug\]\s+(http:\/\/127\.0\.0\.1:\d+\/debug)\b/;
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
const PROCESS_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 90_000;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RuntimeSmokeOptions {
  readonly appPath: string;
  readonly resourcesPath?: string;
}

interface RuntimeSelfTestResult {
  readonly ok: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly checks: Record<string, boolean | null>;
  readonly failedChecks: readonly string[];
}

function appendBounded(current: string, chunk: Uint8Array | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_CAPTURED_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_CAPTURED_OUTPUT_CHARS);
}

export function parseRuntimeSmokeArgs(args: readonly string[]): RuntimeSmokeOptions {
  let appPath: string | undefined;
  let resourcesPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--app") {
      appPath = args[index + 1];
      index += 1;
    } else if (argument === "--resources") {
      resourcesPath = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown native desktop runtime smoke argument: ${argument}`);
    }
  }
  if (!appPath?.trim()) throw new Error("--app is required");
  return {
    appPath: resolve(appPath),
    ...(resourcesPath?.trim() ? { resourcesPath: resolve(resourcesPath) } : {}),
  };
}

export function resolvePackagedResourcesPath(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // This helper validates artifacts for a target platform, which may differ
  // from the CI host. Use the target path implementation rather than the
  // host-global path functions so Windows can validate macOS metadata and the
  // converse remains true.
  if (platform === "darwin") return posix.resolve(posix.dirname(appPath), "../Resources");
  if (platform === "win32") return win32.join(win32.dirname(appPath), "resources");
  return posix.join(posix.dirname(appPath), "resources");
}

export function readDebugUrl(output: string): string | undefined {
  return DEBUG_URL_PATTERN.exec(output)?.[1];
}

/**
 * Docker build workers commonly deny the namespace operations Chromium's Linux sandbox requires.
 * Only the container-specific smoke sets this test-harness flag; native Linux, macOS, and Windows
 * artifact jobs keep the packaged application's normal sandbox behavior.
 */
export function desktopSmokeChromiumSwitches(environment: NodeJS.ProcessEnv): readonly string[] {
  return environment[DISABLE_CHROMIUM_SANDBOX_ENV] === "1" ? ["--no-sandbox"] : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function summarizeDesktopDebugReadiness(value: unknown): Record<string, unknown> {
  const snapshot = readRecord(value);
  const providerDaemon = readRecord(snapshot?.providerDaemon);
  const providerHealth = readRecord(providerDaemon?.lastHealth);
  const renderer = readRecord(snapshot?.renderer);
  const diagnostics = readRecord(renderer?.diagnostics);
  const localApi = readRecord(diagnostics?.localApi);
  const connection = readRecord(renderer?.connection);
  return {
    providerAvailable: providerDaemon?.available === true,
    providerStatus: typeof providerDaemon?.status === "string" ? providerDaemon.status : null,
    providerHealthOk: providerHealth?.ok === true,
    rendererAvailable: renderer?.available === true,
    rendererLocalApiAvailable: localApi?.available === true,
    rendererWebSocketConnected: connection?.connected === true,
  };
}

export function isReadyDesktopDebugSnapshot(value: unknown): boolean {
  const summary = summarizeDesktopDebugReadiness(value);
  return Object.entries(summary).every(
    ([key, entry]) => key === "providerStatus" || entry === true,
  );
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Process timed out: ${command}`));
        return;
      }
      resolveProcess({ exitCode, signal, stdout, stderr });
    });
  });
}

async function reserveTcpPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not reserve a TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

async function waitFor<T>(
  description: string,
  action: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readJsonResponse(url: string): Promise<unknown | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) return undefined;
  return await response.json();
}

async function makeIsolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, "home");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const xdgConfigHome = join(home, ".config");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
  ]);
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfigHome,
    CAFE_CODE_HOME: join(home, ".cafe-code"),
    CAFE_CODE_HTTPS_ENABLED: "false",
  };
}

function assertRuntimeSelfTestResult(value: unknown): RuntimeSelfTestResult {
  const record = readRecord(value);
  if (
    record?.ok !== true ||
    record.isPackaged !== true ||
    record.platform !== process.platform ||
    record.arch !== process.arch ||
    !Array.isArray(record.failedChecks) ||
    record.failedChecks.length !== 0
  ) {
    throw new Error("Packaged desktop runtime self-test failed.");
  }
  return value as RuntimeSelfTestResult;
}

async function runPackagedRuntimeSelfTest(
  appPath: string,
  environment: NodeJS.ProcessEnv,
  root: string,
): Promise<RuntimeSelfTestResult> {
  const resultPath = join(root, "runtime-self-test.json");
  const result = await runProcess(
    appPath,
    ["--disable-gpu", ...desktopSmokeChromiumSwitches(environment), SELF_TEST_SWITCH],
    { env: { ...environment, [SELF_TEST_RESULT_ENV]: resultPath } },
  );
  if (result.exitCode !== 0) throw new Error("Packaged desktop runtime self-test exited nonzero.");
  const decoded = await readJsonFile(resultPath);
  return assertRuntimeSelfTestResult(decoded);
}

async function stopPackagedProcessTree(
  appPath: string,
  resourcesPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const serverEntry = join(resourcesPath, "app.asar", "apps", "server", "dist", "bin.mjs");
  const result = await runProcess(appPath, [serverEntry, "killall"], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Packaged process cleanup command failed.");
}

function forceTerminate(child: ReturnType<typeof spawn>): void {
  if (typeof child.pid !== "number") return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGKILL");
}

async function runPackagedApplicationSmoke(
  appPath: string,
  resourcesPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const port = await reserveTcpPort();
  const child = spawn(
    appPath,
    ["--disable-gpu", ...desktopSmokeChromiumSwitches(environment), "--cafe-debug"],
    {
      env: { ...environment, CAFE_CODE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  let lastDebugReadiness: Record<string, unknown> | undefined;
  child.stdout.on("data", (chunk) => {
    output = appendBounded(output, chunk);
  });
  child.stderr.on("data", (chunk) => {
    output = appendBounded(output, chunk);
  });

  try {
    await waitFor(
      "the packaged backend environment endpoint",
      async () =>
        (await readJsonResponse(`http://127.0.0.1:${port}${ENVIRONMENT_ENDPOINT_PATH}`)) ??
        undefined,
      STARTUP_TIMEOUT_MS,
    );
    const debugUrl = await waitFor(
      "the packaged desktop debug endpoint",
      async () => readDebugUrl(output),
      STARTUP_TIMEOUT_MS,
    );
    try {
      await waitFor(
        "provider daemon health and renderer WebSocket hydration",
        async () => {
          const snapshot = await readJsonResponse(debugUrl);
          lastDebugReadiness = summarizeDesktopDebugReadiness(snapshot);
          return isReadyDesktopDebugSnapshot(snapshot) ? snapshot : undefined;
        },
        STARTUP_TIMEOUT_MS,
      );
    } catch {
      throw new Error(
        `Packaged desktop readiness failed: ${JSON.stringify(lastDebugReadiness ?? {})}`,
      );
    }

    await stopPackagedProcessTree(appPath, resourcesPath, environment);
    if (!(await waitForExit(child, 20_000))) {
      throw new Error("Packaged desktop did not exit after the cleanup command.");
    }
    await waitFor(
      "the packaged backend port to close",
      async () => {
        try {
          await fetch(`http://127.0.0.1:${port}${ENVIRONMENT_ENDPOINT_PATH}`, {
            signal: AbortSignal.timeout(500),
          });
          return undefined;
        } catch {
          return true;
        }
      },
      20_000,
    );
  } finally {
    if (!(await waitForExit(child, 250))) {
      await stopPackagedProcessTree(appPath, resourcesPath, environment).catch(() => undefined);
    }
    if (!(await waitForExit(child, 5_000))) forceTerminate(child);
  }
}

export async function runNativeDesktopRuntimeSmoke(options: RuntimeSmokeOptions): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cafecode-native-runtime-smoke-"));
  const resourcesPath = options.resourcesPath ?? resolvePackagedResourcesPath(options.appPath);
  try {
    const environment = await makeIsolatedEnvironment(root);
    const runtime = await runPackagedRuntimeSelfTest(options.appPath, environment, root);
    await runPackagedApplicationSmoke(options.appPath, resourcesPath, environment);
    console.info(
      JSON.stringify({
        ok: true,
        platform: runtime.platform,
        arch: runtime.arch,
        checks: runtime.checks,
        backendHealth: true,
        providerDaemonHealth: true,
        rendererWebSocketHydration: true,
        cleanShutdown: true,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runNativeDesktopRuntimeSmoke(parseRuntimeSmokeArgs(process.argv.slice(2)));
}
