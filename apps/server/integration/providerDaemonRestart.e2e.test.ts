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

function providerRuntimeChildEnv(cafeCodeHome: string): NodeJS.ProcessEnv {
  // This macOS/Linux canary must never inherit provider credentials, Node
  // hooks, a live Cafe endpoint, or the developer's provider-home directories.
  // Explicitly disabled settings below provide a second independent boundary.
  return {
    PATH: path.dirname(process.execPath),
    HOME: cafeCodeHome,
    ELECTRON_RUN_AS_NODE: "1",
  };
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
      env: providerRuntimeChildEnv(input.cafeCodeHome),
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

describe.skipIf(!RUN_REAL_PROCESS_E2E)("provider daemon isolated restart e2e", () => {
  it("retains local ownership and authenticates the replacement process after restart", async () => {
    // Keep the IPC path short enough for macOS sockaddr_un. mkdtemp gives the
    // cleanup an exclusively owned directory rather than a guessed location.
    const baseDir = await fs.mkdtemp(path.join("/tmp", "ccpd-e2e-"));
    const socketPath = path.join(baseDir, "provider-daemon.sock");
    let firstDaemon: SpawnedDaemon | undefined;
    let secondDaemon: SpawnedDaemon | undefined;

    try {
      await fs.chmod(baseDir, 0o700);
      await fs.mkdir(path.join(baseDir, "userdata"), { mode: 0o700 });
      await fs.writeFile(
        path.join(baseDir, "userdata", "settings.json"),
        JSON.stringify({
          providers: {
            codex: { enabled: false },
            claudeAgent: { enabled: false },
            grok: { enabled: false },
            opencode: { enabled: false },
          },
        }),
        { mode: 0o600, flag: "wx" },
      );

      firstDaemon = spawnProviderDaemon({ cafeCodeHome: baseDir, socketPath });
      const firstHealth = await waitForHealth(firstDaemon);

      assert.equal(firstHealth.mode, "provider-daemon");
      assert.equal(firstHealth.pid, firstDaemon.child.pid);
      assert.equal(firstHealth.activeSessionCount, 0);
      // Automatic supervisor handoff is deliberately disabled by the CLI.
      // This canary verifies the architecture actually shipped, not an older
      // experimental detached-supervisor mode that must remain quarantined.
      assert.isUndefined(firstHealth.upstreamSupervisor);
      assert.isUndefined(firstHealth.supervisorProcess);
      const unauthorized = await requestProviderDaemonJson(
        {
          ...firstDaemon.endpoint,
          token: makeToken(),
        },
        PROVIDER_DAEMON_HEALTH_PATH,
        { timeoutMs: 1_000 },
      );
      assert.equal(unauthorized.statusCode, 401);

      const firstDaemonPid = firstHealth.pid;
      await stopChild(firstDaemon.child);
      assert.isTrue(firstDaemon.child.exitCode !== null || firstDaemon.child.signalCode !== null);
      await fs.rm(socketPath, { force: true });

      secondDaemon = spawnProviderDaemon({ cafeCodeHome: baseDir, socketPath });
      const secondHealth = await waitForHealth(secondDaemon);

      assert.equal(secondHealth.mode, "provider-daemon");
      assert.notEqual(secondHealth.pid, firstDaemonPid);
      assert.equal(secondHealth.pid, secondDaemon.child.pid);
      assert.equal(secondHealth.activeSessionCount, 0);
      assert.isUndefined(secondHealth.upstreamSupervisor);
      assert.isUndefined(secondHealth.supervisorProcess);
      // The same isolated socket/home must not make the previous generation's
      // capability valid for its replacement process.
      const staleCapability = await requestProviderDaemonJson(
        firstDaemon.endpoint,
        PROVIDER_DAEMON_HEALTH_PATH,
        { timeoutMs: 1_000 },
      );
      assert.equal(staleCapability.statusCode, 401);
    } finally {
      await stopChild(secondDaemon?.child);
      await stopChild(firstDaemon?.child);
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  }, 60_000);
});
