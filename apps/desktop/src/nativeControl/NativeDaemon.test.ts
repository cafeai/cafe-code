import { expect, it, vi } from "vitest";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeDaemon, nativeDaemonEnvironment } from "./NativeDaemon.ts";

it("cleans private resources when startup fails before a child exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "cafe-daemon-start-fixture-"));
  const channel = { close: vi.fn(async () => {}) };
  const daemon = new NativeDaemon("unused-start-fixture", "com.cafe.fixture");
  Reflect.set(daemon, "root", root);
  Reflect.set(daemon, "endpoint", join(root, "driver.sock"));
  Reflect.set(daemon, "activityChannel", channel);
  await daemon.stop();
  expect(channel.close).toHaveBeenCalledOnce();
  await expect(access(root)).rejects.toThrow();
  expect(Reflect.get(daemon, "root")).toBeUndefined();
  expect(Reflect.get(daemon, "endpoint")).toBeUndefined();
});

it("force-stops only its owned child without waiting for an existing graceful shutdown", async () => {
  const exited = Promise.withResolvers<void>();
  const child = {
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: { end: vi.fn() },
    kill: vi.fn((signal: string) => {
      child.signalCode = signal;
      exited.resolve();
      return true;
    }),
  };
  // Inject a process handle, never a PID or live native controller. The first
  // stop deliberately remains pending until cancellation kills that handle.
  const daemon = new NativeDaemon("unused-owned-child-fixture", "com.cafe.fixture");
  Reflect.set(daemon, "child", child);
  Reflect.set(daemon, "exited", exited.promise);
  const graceful = daemon.stop();
  expect(child.stdin.end).toHaveBeenCalledOnce();
  expect(child.kill).not.toHaveBeenCalled();
  await daemon.stop({ force: true });
  await graceful;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  await daemon.stop({ force: true });
  expect(child.kill).toHaveBeenCalledOnce();
});
it("isolates Cua preferences and history and never inherits credentials or Node hooks", () => {
  const env = nativeDaemonEnvironment(
    {
      PATH: "fixture-path",
      HOME: "ambient-profile",
      OPENAI_API_KEY: "private",
      ANTHROPIC_API_KEY: "private",
      NODE_OPTIONS: "--require=untrusted",
      NODE_PATH: "untrusted",
      CUA_HOME: "ambient-cua",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "1",
      CUA_DRIVER_RS_UPDATE_CHECK: "true",
    },
    "private-fixture-home",
  );
  expect(env).toMatchObject({
    PATH: "fixture-path",
    HOME: "private-fixture-home",
    CUA_HOME: "private-fixture-home",
    CUA_DRIVER_HOME: "private-fixture-home",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    DO_NOT_TRACK: "1",
  });
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "NODE_PATH"])
    expect(env[key]).toBeUndefined();
});

it("maps Cafe health to the native report and preserves missing permissions as diagnostic state", async () => {
  const report = {
    content: [{ type: "text", text: "Accessibility permission is missing." }],
    structuredContent: {
      schema_version: "1",
      overall: "degraded",
      checks: [{ name: "tcc_accessibility", status: "fail" }],
    },
  };
  // Model the native registry, including its ordinary tool-error reply for an
  // unknown name. This catches a host alias accidentally sent over the wire.
  const connection = {
    request: vi.fn(async (message: Record<string, unknown>) => {
      if (message.method === "trusted_session_end") return { closed: true };
      if (message.method === "trusted_session_call" && message.name === "health_report")
        return report;
      return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
    }),
    close: vi.fn(),
  };
  const daemon = new NativeDaemon("unused-injected-session", "com.cafe.fixture");
  const session = vi.spyOn(daemon, "session").mockResolvedValue(connection);
  try {
    expect(await daemon.health()).toEqual(report);
    expect(connection.request).toHaveBeenLastCalledWith({ method: "trusted_session_end" });
    expect(connection.close).toHaveBeenCalledOnce();
  } finally {
    session.mockRestore();
  }
});
