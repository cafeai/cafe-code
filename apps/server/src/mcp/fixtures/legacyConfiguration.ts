import { applyEdits, modify } from "jsonc-parser";
import type { McpClientConfiguration, McpLaunchSpec } from "../clientConfiguration.ts";
export function legacyMcpConfiguration(
  client: McpClientConfiguration,
  contents: string,
  launch: McpLaunchSpec,
) {
  if (client.format === "toml")
    return (
      contents +
      [
        "# BEGIN Cafe Code managed MCP",
        "[mcp_servers.cafe-code]",
        "command = " + JSON.stringify(launch.command),
        "args = " + JSON.stringify(launch.args),
        'env = { ELECTRON_RUN_AS_NODE = "1" }',
        "# END Cafe Code managed MCP",
        "",
      ].join("\n")
    );
  const entry =
    client.id === "opencode"
      ? {
          type: "local",
          command: [launch.command, ...launch.args],
          environment: launch.env,
          enabled: true,
        }
      : {
          ...(client.id === "claude" ? { type: "stdio" } : {}),
          command: launch.command,
          args: launch.args,
          env: launch.env,
        };
  return applyEdits(
    contents,
    modify(contents, [client.key, "cafe-code"], entry, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}
