import { expect, it, vi } from "vitest";
import { NativeDaemon, nativeDaemonEnvironment } from "./NativeDaemon.ts";
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
