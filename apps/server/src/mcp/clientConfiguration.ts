import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import * as Toml from "toml";
import type { CafeMcpClientId } from "@cafecode/contracts";

import { McpFileError } from "./privateFiles.ts";

// This installer owns only Cafe's management connection. Desktop Control is a
// separate, session-injected MCP; installing/removing Cafe must never edit it.
export const CAFE_MCP_SERVER_NAME = "cafe-code";
const BEGIN = "# BEGIN Cafe Code managed MCP";
const END = "# END Cafe Code managed MCP";

export interface McpLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface McpClientConfiguration {
  readonly id: CafeMcpClientId;
  readonly name: string;
  readonly filePath: string;
  readonly format: "toml" | "json";
  readonly key: "mcp_servers" | "mcpServers" | "mcp";
}

export function mcpClientConfigurations(
  home: string,
  env: NodeJS.ProcessEnv,
): McpClientConfiguration[] {
  // User scope only. Never place these entries in a project's shared config.
  // Codex/Grok use mcp_servers (official CLI help); Claude's user scope is
  // .claude.json (code.claude.com/docs/en/mcp). OpenCode matches the pinned
  // @opencode-ai/sdk v1 Config.mcp type, not the incompatible v2 website layout.
  return [
    {
      id: "codex",
      name: "Codex",
      filePath: path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
      format: "toml",
      key: "mcp_servers",
    },
    {
      id: "claude",
      name: "Claude Code",
      filePath: env.CLAUDE_CONFIG_DIR
        ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : path.join(home, ".claude.json"),
      format: "json",
      key: "mcpServers",
    },
    {
      id: "grok",
      name: "Grok",
      filePath: path.join(env.GROK_HOME || path.join(home, ".grok"), "config.toml"),
      format: "toml",
      key: "mcp_servers",
    },
    {
      id: "opencode",
      name: "OpenCode",
      filePath:
        env.OPENCODE_CONFIG ||
        path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode", "opencode.json"),
      format: "json",
      key: "mcp",
    },
  ];
}

export function mcpClientEntry(
  client: McpClientConfiguration,
  launch: McpLaunchSpec,
): Record<string, unknown> {
  if (client.id === "opencode") {
    return {
      type: "local",
      command: [launch.command, ...launch.args],
      environment: launch.env,
      enabled: true,
    };
  }
  return {
    ...(client.id === "claude" ? { type: "stdio" } : {}),
    command: launch.command,
    args: launch.args,
    env: launch.env,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function plainTables(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainTables);
  if (value instanceof Date) return value;
  const table = record(value);
  return table
    ? Object.fromEntries(Object.entries(table).map(([key, entry]) => [key, plainTables(entry)]))
    : value;
}

function validateJsonTree(node: JsonNode | undefined, depth = 0): void {
  if (!node || depth > 80) throw new Error();
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value;
      if (typeof key !== "string" || keys.has(key)) throw new Error();
      keys.add(key);
      validateJsonTree(property.children?.[1], depth + 1);
    }
  } else if (node.type === "array") {
    for (const child of node.children ?? []) validateJsonTree(child, depth + 1);
  }
}

function parseConfiguration(
  client: McpClientConfiguration,
  contents: string,
): Record<string, unknown> {
  try {
    const errors: ParseError[] = [];
    if (client.format === "json")
      validateJsonTree(parseTree(contents || "{}", errors, { allowTrailingComma: true }));
    const value: unknown =
      client.format === "toml"
        ? plainTables(Toml.parse(contents, { maxDepth: 80 }))
        : parse(contents || "{}", errors, { allowTrailingComma: true });
    const root = record(value);
    if (!root || errors.length) throw new Error();
    if (root[client.key] !== undefined && !record(root[client.key])) throw new Error();
    return root;
  } catch {
    throw new McpFileError(
      "The provider configuration is invalid. Fix it before installing Cafe MCP.",
    );
  }
}

export function readMcpClientEntry(client: McpClientConfiguration, contents: string): unknown {
  return record(parseConfiguration(client, contents)[client.key])?.[CAFE_MCP_SERVER_NAME];
}

export function isManagedMcpEntry(entry: unknown, launch: McpLaunchSpec): boolean {
  const value = record(entry);
  // The stable, private connection-file path is this Cafe environment's identity.
  // Permit a runtime executable update while refusing another Cafe environment's
  // registration or a same-named unrelated server.
  const args =
    value?.type === "local" && Array.isArray(value.command) ? value.command.slice(1) : value?.args;
  return Array.isArray(args) && isDeepStrictEqual(args, launch.args);
}

export function isMcpEntryReady(
  client: McpClientConfiguration,
  entry: unknown,
  launch: McpLaunchSpec,
): boolean {
  const value = record(entry);
  const expected = mcpClientEntry(client, launch);
  const envKey = client.id === "opencode" ? "environment" : "env";
  return (
    value !== undefined &&
    value.enabled !== false &&
    isDeepStrictEqual(value.command, expected.command) &&
    value.type === expected.type &&
    record(value[envKey])?.ELECTRON_RUN_AS_NODE === "1"
  );
}

export function editMcpClientConfiguration(
  client: McpClientConfiguration,
  contents: string,
  launch: McpLaunchSpec,
  operation: "install" | "remove",
): string {
  const current = readMcpClientEntry(client, contents);
  if (current !== undefined && !isManagedMcpEntry(current, launch)) {
    throw new McpFileError(
      "A different cafe-code MCP registration already exists. It was left unchanged.",
    );
  }
  if (operation === "remove" && current === undefined) return contents;
  const entry = operation === "install" ? mcpClientEntry(client, launch) : undefined;
  if (isDeepStrictEqual(entry, current)) return contents;

  let next: string;
  if (client.format === "json") {
    next = applyEdits(
      contents || "{}\n",
      modify(contents || "{}\n", [client.key, CAFE_MCP_SERVER_NAME], entry, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: contents.includes("\r\n") ? "\r\n" : "\n",
        },
      }),
    );
  } else {
    // Keep the user's TOML byte-for-byte outside our marked block. Validate
    // both the candidate document and its unrelated values; marker-like text
    // inside multiline strings must never trick us into deleting user config.
    let base = contents;
    const start = contents.indexOf(BEGIN);
    const end = contents.indexOf(END);
    if (start !== -1 || end !== -1) {
      if (
        start === -1 ||
        end < start ||
        contents.indexOf(BEGIN, start + BEGIN.length) !== -1 ||
        contents.indexOf(END, end + END.length) !== -1
      ) {
        throw new McpFileError(
          "The Cafe MCP configuration block was edited. Restore it before reinstalling.",
        );
      }
      base = contents.slice(0, start) + contents.slice(end + END.length).replace(/^\r?\n/, "");
    } else if (current !== undefined) {
      throw new McpFileError(
        "The Cafe MCP entry is managed outside Cafe. Remove it there before reinstalling.",
      );
    }
    const newline = contents.includes("\r\n") ? "\r\n" : "\n";
    const block = [
      BEGIN,
      `[mcp_servers.${CAFE_MCP_SERVER_NAME}]`,
      `command = ${JSON.stringify(launch.command)}`,
      `args = ${JSON.stringify(launch.args)}`,
      `env = { ${Object.entries(launch.env)
        .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
        .join(", ")} }`,
      END,
      "",
    ].join(newline);
    next =
      operation === "install"
        ? `${base}${base.endsWith("\n") || !base ? "" : newline}${block}`
        : base;
  }
  const before = parseConfiguration(client, contents);
  const after = parseConfiguration(client, next);
  const expected = { ...before, [client.key]: { ...record(before[client.key]) } };
  const servers = expected[client.key] as Record<string, unknown>;
  if (entry === undefined) delete servers[CAFE_MCP_SERVER_NAME];
  else servers[CAFE_MCP_SERVER_NAME] = entry;
  // TOML removal of the last table removes its implicit parent as well.
  if (Object.keys(servers).length === 0 && after[client.key] === undefined)
    delete expected[client.key];
  if (!isDeepStrictEqual(after, expected)) {
    throw new McpFileError(
      "Cafe MCP could not preserve the provider configuration. No changes were saved.",
    );
  }
  return next;
}
