import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  NATIVE_CONTROL_ENVIRONMENT,
  NATIVE_CONTROL_VERSION,
  type NativeToolResult,
} from "@cafecode/shared/nativeControl";
import { verifyNativeRuntime } from "@cafecode/shared/nativeRuntime";
export { verifyNativeRuntime } from "@cafecode/shared/nativeRuntime";

export interface NativeDaemonConnection {
  request: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}

/** One bounded request at a time on one connection. Losing a reply never causes
 * an input replay; the owning host retires the helper generation instead. */
export function connectNativeDaemon(
  endpoint: string,
  timeoutMs = 30_000,
): Promise<NativeDaemonConnection> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(endpoint);
    let pending:
      | {
          resolve: (value: Record<string, unknown>) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    let buffered = Buffer.alloc(0);
    const fail = () => {
      const error = new Error(
        "Native controller connection closed before acknowledged completion.",
      );
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        pending = undefined;
      }
      reject(error);
    };
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16 * 1024 * 1024) {
        socket.destroy();
        fail();
        return;
      }
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (!pending || buffered.length) {
        socket.destroy();
        fail();
        return;
      }
      const waiting = pending;
      pending = undefined;
      clearTimeout(waiting.timer);
      try {
        const response = JSON.parse(line.toString("utf8")) as {
          ok?: boolean;
          result?: Record<string, unknown>;
        };
        if (response.ok !== true || !response.result || typeof response.result !== "object")
          throw new Error();
        waiting.resolve(response.result);
      } catch {
        waiting.reject(new Error("Native controller refused the request."));
      }
    });
    const connected = setTimeout(
      () => {
        socket.destroy();
        reject(new Error("Native controller connection timed out."));
      },
      Math.min(timeoutMs, 1000),
    );
    socket.once("connect", () => {
      clearTimeout(connected);
      resolve({
        request: (message) =>
          new Promise((success, failure) => {
            if (socket.destroyed || pending) {
              failure(new Error("Native controller is unavailable or busy."));
              return;
            }
            const timer = setTimeout(() => {
              socket.destroy();
              fail();
            }, timeoutMs);
            pending = { resolve: success, reject: failure, timer };
            socket.write(`${JSON.stringify(message)}\n`, (error) => {
              if (error) fail();
            });
          }),
        close: () => socket.destroy(),
      });
    });
    socket.once("close", () => clearTimeout(connected));
  });
}

export function nativeDaemonEnvironment(
  parent: NodeJS.ProcessEnv,
  stateDirectory: string,
): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (parent[name] !== undefined) env[name] = parent[name];
  return {
    ...env,
    ...NATIVE_CONTROL_ENVIRONMENT,
    HOME: stateDirectory,
    CUA_HOME: stateDirectory,
    CUA_DRIVER_HOME: stateDirectory,
    CUA_DRIVER_RS_HOME: stateDirectory,
    CUA_DRIVER_LOCAL_HOME: stateDirectory,
    XDG_STATE_HOME: stateDirectory,
    CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
  };
}

export class NativeDaemon {
  private readonly runtimeRoot: string;
  private readonly hostBundleId: string;
  private child: ChildProcess | undefined;
  private root: string | undefined;
  private endpoint: string | undefined;
  private exited: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  constructor(runtimeRoot: string, hostBundleId: string) {
    this.runtimeRoot = runtimeRoot;
    this.hostBundleId = hostBundleId;
  }

  async start(): Promise<void> {
    await this.stopping;
    if (this.child) return;
    const executable = await verifyNativeRuntime(this.runtimeRoot);
    this.root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cafe-cua-")));
    this.endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cafe-cua-${randomUUID()}`
        : join(this.root, "driver.sock");
    const child = spawn(
      executable,
      [
        "serve",
        "--embedded",
        "--parent-liveness-stdio",
        "--no-permissions-gate",
        "--cursor-reduced-motion",
        "auto",
        "--socket",
        this.endpoint,
        "--host-bundle-id",
        this.hostBundleId,
        "--permission-mode",
        "standard",
      ],
      {
        env: nativeDaemonEnvironment(process.env, this.root),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    this.child = child;
    child.stdin?.on("error", () => {
      /* A dead owned child cannot accept further input. */
    });
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid)
          throw new Error("Native Cua exited before readiness.");
        const connection = await connectNativeDaemon(this.endpoint, 500).catch(() => undefined);
        if (connection) {
          try {
            const metadata = await connection.request({ method: "metadata" });
            if (
              metadata.pid !== child.pid ||
              metadata.driver_version !== NATIVE_CONTROL_VERSION ||
              metadata.contract_version !== "0.8.0" ||
              metadata.embedded !== true ||
              metadata.host_bundle_id !== this.hostBundleId
            )
              throw new Error("Native Cua readiness identity does not match its owned process.");
            return;
          } finally {
            connection.close();
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Native Cua did not become ready.");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async session(label: string): Promise<NativeDaemonConnection> {
    if (
      !this.endpoint ||
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      throw new Error("Native desktop control is off.");
    const connection = await connectNativeDaemon(this.endpoint);
    try {
      await connection.request({
        method: "trusted_session_begin",
        args: {
          public_session: label,
          mode: "standard",
          ttl_seconds: 3600,
          idle_ttl_seconds: 300,
          capability_manifest_path: null,
          bounded_manifest_path: null,
        },
      });
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async health(): Promise<NativeToolResult> {
    const connection = await this.session(`diagnostics-${randomUUID()}`);
    try {
      return (await connection.request({
        method: "trusted_session_call",
        // Cafe's public `health` tool is a host alias. The pinned Cua 0.34.0
        // registry exposes `health_report` (core/src/health_report.rs), whose
        // schema_version=1 report includes TCC state without prompting or
        // attempting a screen capture. Keep missing grants distinct from a
        // tool failure; the driver's report can validly be degraded.
        name: "health_report",
        args: {},
      })) as unknown as NativeToolResult;
    } finally {
      await connection.request({ method: "trusted_session_end" }).finally(() => connection.close());
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = this.stopOwnedChild();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopOwnedChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const root = this.root;
    child.stdin?.end();
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
    try {
      await this.exited;
    } finally {
      clearTimeout(force);
      this.child = undefined;
      this.endpoint = undefined;
    }
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      if (this.root === root) this.root = undefined;
    }
  }
}
