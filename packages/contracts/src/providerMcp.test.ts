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

it("admits disabled native HTTP MCP entries without treating their empty command as a local executable", () => {
  const decode = Schema.decodeUnknownSync(ProviderMcpState);
  const remote = {
    name: "remote",
    displayName: "Remote tools",
    command: "",
    args: [],
    remote: {
      url: "https://mcp.example.com/mcp",
      auth: "oauth",
      clientId: "public-client",
      clientMetadataUrl: "https://cafe.example.com/client.json",
      bearerToken: "private-bearer",
    },
    enabled: false,
    environmentKeys: [],
    credentialId: "private-credential",
    tools: [],
    status: "needs_auth",
    error: null,
  };
  const state = decode({
    revision: 4,
    remoteSupported: true,
    selectedTools: [],
    servers: [remote],
  });
  expect(state.remoteSupported).toBe(true);
  expect(state.servers[0]).toMatchObject({
    command: "",
    enabled: false,
    remote: {
      url: "https://mcp.example.com/mcp",
      auth: "oauth",
      clientId: "public-client",
    },
  });
  expect(JSON.stringify(state)).not.toContain("private-");
  for (const patch of [
    { remote: undefined },
    { remote: null },
    { command: "launch-local" },
    { args: ["--secret"] },
    { environmentKeys: ["SECRET"] },
    { remote: { url: "https://user:password@mcp.example.com/mcp", auth: "none" } },
    { remote: { url: "https://mcp.example.com/mcp?token=private", auth: "bearer" } },
    { remote: { url: "https://mcp.example.com/mcp#private", auth: "none" } },
    { remote: { url: "http://mcp.example.com/mcp", auth: "none" } },
    { remote: { url: "file:///tmp/mcp", auth: "none" } },
    { remote: { url: "https://mcp.example.com/mcp", auth: "unknown" } },
    { remote: { url: "https://mcp.example.com/mcp", auth: "bearer", clientId: "oauth-only" } },
  ]) {
    expect(() => decode({ ...state, servers: [{ ...remote, ...patch }] })).toThrow();
  }
  expect(
    decode({
      revision: 4,
      selectedTools: [],
      servers: [{ ...remote, remote: { url: "http://127.0.0.1:8000/mcp", auth: "none" } }],
    }).servers[0]?.remote?.url,
  ).toBe("http://127.0.0.1:8000/mcp");
});
