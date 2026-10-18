import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { glideInstructions, jsInputSchema, type GlideInputMode } from "./protocol.ts";
import { glideExecutionFailure, type GlideRuntime } from "./runtime.ts";

export function createGlideMcpServer(
  runtime: Pick<GlideRuntime, "execute" | "reset">,
  inputMode: GlideInputMode = "background",
  managed = false,
) {
  const instructions = glideInstructions(inputMode, managed);
  const server = new McpServer({ name: "cafe-glide", version: "0.1.0" }, { instructions });
  server.registerTool(
    "js",
    {
      title: "Run Glide JavaScript",
      description: instructions,
      inputSchema: jsInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input, extra) => {
      try {
        return await runtime.execute(input, extra.signal);
      } catch (error) {
        return glideExecutionFailure(error);
      }
    },
  );
  server.registerTool(
    "js_reset",
    {
      title: "Reset the Glide kernel",
      description:
        "Discard JavaScript bindings, native observations and queued work. Earlier edits and already-dispatched input remain. Applications stay open.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      await runtime.reset();
      return {
        content: [
          {
            type: "text" as const,
            text: "Glide kernel reset. Earlier application edits remain.",
          },
        ],
      };
    },
  );
  return server;
}
