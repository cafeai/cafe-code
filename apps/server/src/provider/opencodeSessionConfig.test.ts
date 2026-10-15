import { describe, expect, it } from "vitest";
import { openCodeSessionConfig } from "./opencodeRuntime.ts";
describe("OpenCode launch-only management configuration", () => {
  it("keeps inventory/default launches empty and carries only the admitted local bridge", () => {
    expect(openCodeSessionConfig()).toBe("{}");
    const binding = {
      name: "cafe-code-fixture",
      launch: {
        command: "C:\\Cafe App\\Cafe.exe",
        args: ["C:\\Private Files\\bridge.mjs", "C:\\Private Files\\connection.json"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    };
    expect(JSON.parse(openCodeSessionConfig(binding))).toEqual({
      mcp: {
        [binding.name]: {
          type: "local",
          command: [binding.launch.command, ...binding.launch.args],
          environment: { ELECTRON_RUN_AS_NODE: "1" },
          enabled: true,
        },
      },
    });
    expect(openCodeSessionConfig(binding)).not.toMatch(/permission|authorization|Bearer/);
  });
});
