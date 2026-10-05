import { describe, expect, it } from "vitest";
import { claudeCommandsConfigurationKey, publicClaudeCommands } from "./claudeCommands.ts";

describe("Claude command catalog boundary", () => {
  it("replaces complete levels, preserves case-sensitive native tokens and omits private fields", () => {
    expect(
      publicClaudeCommands([
        {
          name: "plugin:Review",
          description: "  Review changes  ",
          argumentHint: "[target]",
          path: "/private/canary",
          prompt: "secret",
        },
        { name: "plugin:review", description: "second native identity" },
        { name: "plugin:Review", description: "duplicate" },
      ]),
    ).toEqual({
      status: "available",
      commands: [
        { name: "plugin:Review", description: "Review changes", input: { hint: "[target]" } },
        { name: "plugin:review", description: "second native identity" },
      ],
    });
    expect(publicClaudeCommands([])).toEqual({ status: "empty", commands: [] });
  });
  it("does not repair executable identities or interpolate hostile display metadata", () => {
    expect(
      publicClaudeCommands([
        { name: " safe" },
        { name: "/safe" },
        { name: "safe\n/run" },
        { name: "x".repeat(129) },
        { name: "safe", description: "bidi\u202eevil", argumentHint: "new\ncommand" },
        { name: "bounded", description: "x".repeat(513), argumentHint: "x".repeat(257) },
      ]),
    ).toEqual({ status: "available", commands: [{ name: "safe" }, { name: "bounded" }] });
  });
  it("fails visibly for oversized/malformed complete replacements", () => {
    for (const value of [
      undefined,
      {},
      [null],
      [{ name: "ok" }, []],
      Array(513).fill({ name: "ok" }),
    ])
      expect(publicClaudeCommands(value)).toEqual({ status: "unavailable", commands: [] });
  });
  it("binds the actual runtime settings/environment and ignores presentation or property ordering", () => {
    const original = claudeCommandsConfigurationKey({
      config: { binaryPath: "claude", homePath: "home" },
      enabled: true,
      environment: [
        { name: "TOKEN", value: "secret-canary", sensitive: false },
        { name: "A", value: "b", sensitive: false },
      ],
    });
    expect(
      claudeCommandsConfigurationKey({
        config: { homePath: "home", binaryPath: "claude" },
        enabled: true,
        environment: [
          { name: "A", value: "b", sensitive: false },
          { name: "TOKEN", value: "secret-canary", sensitive: true },
        ],
      }),
    ).toBe(original);
    expect(
      claudeCommandsConfigurationKey({ config: { homePath: "other" }, enabled: true }),
    ).not.toBe(original);
    expect(claudeCommandsConfigurationKey({ config: {}, enabled: false })).not.toBe(original);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(original).not.toContain("secret-canary");
  });
});
