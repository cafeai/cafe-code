import { describe, expect, it } from "vitest";

import { resolveDevelopmentInvocation } from "./dev.mjs";

describe("desktop development supervisor", () => {
  it("runs the locked bundler directly through Node", () => {
    const invocation = resolveDevelopmentInvocation("dev:bundle");
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args.at(-1)).toBe("--watch");
    expect(invocation.args[0]).toMatch(/node_modules[/\\]tsdown[/\\]dist[/\\]run\.mjs$/u);
  });

  it("runs the Electron watcher directly through Node", () => {
    const invocation = resolveDevelopmentInvocation("dev:electron");
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toMatch(/scripts[/\\]dev-electron\.mjs$/u);
  });

  it("rejects unknown development children", () => {
    expect(() => resolveDevelopmentInvocation("unknown")).toThrow(
      "Unsupported desktop development child",
    );
  });
});
