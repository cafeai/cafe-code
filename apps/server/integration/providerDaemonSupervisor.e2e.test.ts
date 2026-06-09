// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  PROVIDER_DAEMON_HEALTH_PATH,
  ProviderDaemonBootstrap,
  ProviderDaemonHealth,
  type ProviderDaemonClientConfig,
  type ProviderDaemonHealth as ProviderDaemonHealthValue,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import { assert, describe, it } from "vitest";
import * as Schema from "effect/Schema";

const RUN_REAL_PROCESS_E2E = process.env.CAFE_CODE_PROVIDER_DAEMON_E2E === "1";
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const EXIT_TIMEOUT_MS = 5_000;

const encodeProviderDaemonBootstrapJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonBootstrap),
);
const decodeProviderDaemonHealthJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);

interface SpawnedDaemon {
  readonly child: ChildProcess;
  readonly endpoint: ProviderDaemonClientConfig;
  readonly logs: () => string;
}

function shortTempRoot(): string {
  const suffix = crypto.randomBytes(6).toString("hex");
  return path.join("/tmp", `ccpd-e2e-${process.pid}-${suffix}`);
}

function makeToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function backendEntryPath(): string {
  return path.resolve(import.meta.dirname, "../src/bin.ts");
}

function collectChildLogs(child: ChildProcess): () => string {
  let output = "";
  const append = (source: string, chunk: Buffer | string) => {
    output += `[${source}] ${String(chunk)}`;
    if (output.length > 40_000) {
      output = output.slice(output.length - 40_000);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.on("error", (error) => append("error", `${error.message}\n`));
  child.on("exit", (code, signal) => append("exit", `code=${code} signal=${signal}\n`));
  return () => output;
}

function providerRuntimeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of [
    "CAFE_CODE_PORT",
    "CAFE_CODE_MODE",
    "CAFE_CODE_NO_BROWSER",
    "CAFE_CODE_HOST",
    "CAFE_CODE_DEV_URL",
    "CAFE_CODE_DESKTOP_DEV",
    "CAFE_CODE_DESKTOP_WS_URL",
    "CAFE_CODE_DESKTOP_LAN_ACCESS",
    "CAFE_CODE_DESKTOP_LAN_HOST",
    "CAFE_CODE_DESKTOP_HTTPS_ENDPOINTS",
    "VITE_DEV_SERVER_URL",
  ]) {
    delete env[name];
  }
  return env;
}

function spawnProviderDaemon(input: {
  readonly cafeCodeHome: string;
  readonly socketPath: string;
}): SpawnedDaemon {
  const token = makeToken();
  const endpoint: ProviderDaemonClientConfig = {
    httpBaseUrl: "http://provider-daemon.local",
    transport: "ipc",
    socketPath: input.socketPath,
    token,
  };
  const bootstrap = encodeProviderDaemonBootstrapJson({
    mode: "provider-daemon",
    transport: "ipc",
    socketPath: input.socketPath,
    cafeCodeHome: input.cafeCodeHome,
    token,
  });
  const child = spawn(
    process.execPath,
    [backendEntryPath(), "provider-daemon", "--bootstrap-fd", "3"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: providerRuntimeChildEnv(),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const logs = collectChildLogs(child);
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream === null || bootstrapStream === undefined) {
    child.kill("SIGTERM");
    throw new Error("Provider daemon bootstrap fd was not available.");
  }
  (bootstrapStream as NodeJS.WritableStream).end(`${bootstrap}\n`);
  return { child, endpoint, logs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(spawned: SpawnedDaemon): Promise<ProviderDaemonHealthValue> {
  const startedAt = Date.now();
  let lastError: unknown = undefined;
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
      throw new Error(`Provider daemon exited before health became ready.\n${spawned.logs()}`);
    }
    try {
      const response = await requestProviderDaemonJson(
        spawned.endpoint,
        PROVIDER_DAEMON_HEALTH_PATH,
        { timeoutMs: 1_000 },
      );
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return decodeProviderDaemonHealthJson(response.body);
      }
      lastError = new Error(`health returned HTTP ${response.statusCode}: ${response.body}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Provider daemon health did not become ready: ${detail}\n${spawned.logs()}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (!(await waitForChildExit(child, EXIT_TIMEOUT_MS))) {
    child.kill("SIGKILL");
    await waitForChildExit(child, EXIT_TIMEOUT_MS);
  }
}

async function terminatePid(pid: number | undefined): Promise<void> {
  if (pid === undefined || pid <= 0 || pid === process.pid || !isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < EXIT_TIMEOUT_MS) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

describe.skipIf(!RUN_REAL_PROCESS_E2E)("provider daemon detached supervisor e2e", () => {
  it("adopts the same detached supervisor after daemon restart", async () => {
    const baseDir = shortTempRoot();
    const socketPath = path.join(baseDir, "provider-daemon.sock");
    let firstDaemon: SpawnedDaemon | undefined;
    let secondDaemon: SpawnedDaemon | undefined;
    let supervisorPid: number | undefined;

    try {
      await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });

      firstDaemon = spawnProviderDaemon({ cafeCodeHome: baseDir, socketPath });
      const firstHealth = await waitForHealth(firstDaemon);
      supervisorPid = firstHealth.upstreamSupervisor?.pid;

      assert.equal(firstHealth.mode, "provider-daemon");
      assert.equal(firstHealth.upstreamSupervisor?.reachable, true);
      assert.equal(firstHealth.upstreamSupervisor?.mode, "provider-supervisor");
      assert.equal(firstHealth.supervisorProcess?.status, "spawned");
      assert.equal(firstHealth.supervisorProcess?.adoptedExistingProcess, false);
      assert.equal(firstHealth.supervisorProcess?.pid, supervisorPid);
      assert.isDefined(supervisorPid);
      const detachedSupervisorPid = supervisorPid;
      assert.isTrue(isPidAlive(detachedSupervisorPid));

      const firstDaemonPid = firstHealth.pid;
      await stopChild(firstDaemon.child);
      await fs.rm(socketPath, { force: true });

      secondDaemon = spawnProviderDaemon({ cafeCodeHome: baseDir, socketPath });
      const secondHealth = await waitForHealth(secondDaemon);

      assert.equal(secondHealth.mode, "provider-daemon");
      assert.notEqual(secondHealth.pid, firstDaemonPid);
      assert.equal(secondHealth.upstreamSupervisor?.reachable, true);
      assert.equal(secondHealth.upstreamSupervisor?.mode, "provider-supervisor");
      assert.equal(secondHealth.upstreamSupervisor?.pid, detachedSupervisorPid);
      assert.equal(secondHealth.supervisorProcess?.status, "adopted");
      assert.equal(secondHealth.supervisorProcess?.adoptedExistingProcess, true);
      assert.equal(secondHealth.supervisorProcess?.pid, detachedSupervisorPid);
      assert.isTrue(isPidAlive(detachedSupervisorPid));
    } finally {
      await stopChild(secondDaemon?.child);
      await stopChild(firstDaemon?.child);
      await terminatePid(supervisorPid);
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  }, 60_000);
});
