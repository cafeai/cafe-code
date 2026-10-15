import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { ProviderMcpServerInput, ProviderMcpState } from "./providerMcp.ts";

it("admits native MCP command and secret sizes and rejects invalid names, environment and argument lists", () => {
  const decode = Schema.decodeUnknownSync(ProviderMcpServerInput);
  const server = {
    name: "fixture",
    command: "x".repeat(4096),
    args: ["a"],
    enabled: true,
    env: { SECRET: "x".repeat(16384) },
  };
  expect(decode(server)).toEqual(server);
  for (const patch of [
    { name: "Bad name" },
    { name: "_fixture" },
    { name: "fixture_" },
    { name: "f".repeat(49) },
    { command: " " },
    { command: "a\nb" },
    { command: "x".repeat(4097) },
    { args: Array.from({ length: 129 }, () => "a") },
    { args: ["\0"] },
    { env: { SECRET: "x".repeat(16385) } },
    { env: { "1INVALID": "x" } },
  ])
    expect(() => decode({ ...server, ...patch })).toThrow();
});

it("drops native credential identifiers and environment values from returned MCP state", () => {
  const state = Schema.decodeUnknownSync(ProviderMcpState)({
    revision: 1,
    selectedTools: [],
    servers: [
      {
        name: "fixture",
        command: "fixture",
        args: [],
        enabled: true,
        environmentKeys: ["SECRET"],
        env: { SECRET: "private-value" },
        credentialId: "private-credential-id",
        tools: [],
        status: "untested",
        error: null,
      },
    ],
  });
  expect(JSON.stringify(state)).not.toContain("private-");
  expect(state.servers[0]?.environmentKeys).toEqual(["SECRET"]);
});
