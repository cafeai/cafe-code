import { expect, it } from "vitest";
import { nativeDaemonEnvironment } from "./NativeDaemon.ts";
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
