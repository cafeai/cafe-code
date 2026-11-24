// @effect-diagnostics nodeBuiltinImport:off
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { resolveClaudeMcpServersDelivery } from "./claudeQueryProcess.ts";

it("keeps private MCP configuration out of native argv using the actual SDK initialize protocol", async ({
  signal,
  onTestFinished,
}) => {
  // The real SDK serializes the launch and initialize exchange, but the
  // supported spawn hook supplies only these test-owned in-memory streams.
  // No provider executable, credential, profile or MCP server is opened.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: (_signal: NodeJS.Signals) => {
      retire();
      return true;
    },
  });
  let runtime: ReturnType<typeof query> | undefined;
  let retired = false;
  let launchArgs: string[] | undefined;
  let initializeServers: unknown;
  let pending = "";
  const retire = () => {
    if (retired) return;
    retired = true;
    child.killed = true;
    child.exitCode = 0;
    child.stdout.end();
    child.stdin.end();
    child.emit("exit", 0, null);
    runtime?.close();
  };
  // Register both public cancellation and completion before SDK acquisition;
  // an expired test cannot leave an iterator, stream or pending initialization.
  signal.addEventListener("abort", retire, { once: true });
  onTestFinished(() => {
    retire();
    signal.removeEventListener("abort", retire);
    child.stdin.destroy();
    child.stdout.destroy();
  });
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    if (retired) return;
    pending += chunk;
    if (Buffer.byteLength(pending, "utf8") > 65_536) {
      retire();
      return;
    }
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // An invalid SDK frame closes only this inert peer; it must not escape
        // its EventEmitter callback as an uncaught test-process exception.
        retire();
        return;
      }
      if (message.type !== "control_request" || message.request?.subtype !== "initialize") continue;
      initializeServers = message.request.mcpServers;
      child.stdout.write(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {
              commands: [],
              agents: [],
              models: [],
              mcp_servers_applied: true,
            },
          },
        }) + "\n",
      );
    }
  });
  const mcpServers: NonNullable<Options["mcpServers"]> = {
    "cafe-private-fixture": {
      type: "stdio",
      command: "inert-fixture-command",
      args: ["private-connection-path-sentinel"],
      env: { CAFE_SYNTHETIC_PRIVATE_TOKEN: "private-token-sentinel" },
    },
  };
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  };
  runtime = query({
    prompt,
    options: {
      settingSources: [],
      env: {},
      pathToClaudeCodeExecutable: "inert-fixture-command",
      mcpServers,
      mcpServersDelivery: resolveClaudeMcpServersDelivery("2.1.326"),
      spawnClaudeCodeProcess: ({ args }) => {
        launchArgs = [...args];
        return child;
      },
    },
  });
  await runtime.initializationResult();
  expect(launchArgs).toBeDefined();
  expect(launchArgs?.join(" ")).not.toContain("private-connection-path-sentinel");
  expect(launchArgs?.join(" ")).not.toContain("private-token-sentinel");
  expect(launchArgs).not.toContain("--mcp-config");
  expect(initializeServers).toEqual(mcpServers);
});
