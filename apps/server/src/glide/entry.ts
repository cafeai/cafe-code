import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";
import { createGlideMcpServer } from "./mcp.ts";
import { GlideRuntime, validateGlideHelper } from "./runtime.ts";
import { createGlideStdioInput } from "./stdioInput.ts";
import { glideInputModeSchema } from "./protocol.ts";

export async function runGlideMcp(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "native-helper": { type: "string" },
      "allow-app": { type: "string", multiple: true },
      "input-mode": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values["native-helper"])
    throw new Error("Specify --native-helper and at least one --allow-app bundle ID.");
  const helperPath = await validateGlideHelper(values["native-helper"]);
  const inputMode = glideInputModeSchema.parse(values["input-mode"]);
  const runtime = new GlideRuntime({
    helperPath,
    allowedApps: values["allow-app"] ?? [],
    inputMode,
  });
  const server = createGlideMcpServer(runtime, inputMode);
  const input = createGlideStdioInput();
  const transport = new StdioServerTransport(input, process.stdout);
  const stop = () => {
    process.stdin.unpipe(input);
    process.stdin.pause();
    void runtime.close().finally(() => server.close());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // The MCP SDK exposes an onclose callback property, not an EventTarget API.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.server.onclose = () => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    void runtime.close();
  };
  process.stdin.once("end", stop);
  input.once("error", stop);
  process.stdin.pipe(input);
  try {
    await server.connect(transport);
  } catch {
    await runtime.close();
    throw new Error("Glide MCP connection failed.");
  }
}

if (import.meta.main) {
  runGlideMcp().catch(() => {
    process.stderr.write(
      "Glide MCP startup failed. Check the helper path and explicit application allowlist.\n",
    );
    process.exitCode = 1;
  });
}
