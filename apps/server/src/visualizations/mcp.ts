import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { VisualizationArtifactService } from "./store.ts";
import type { VisualizationSessionAuthority } from "./sessionRuntime.ts";

const inputSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("generated-visualization"),
    requestId: z.uuid(),
    source: z
      .string()
      .min(1)
      .max(512 * 1024),
    title: z.string().min(1).max(160),
    assets: z
      .array(
        z
          .object({
            assetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
            attachmentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          })
          .strict(),
      )
      .max(16),
    appearance: z.enum(["auto", "light", "dark"]),
    viewport: z
      .object({
        width: z.number().int().min(240).max(1600),
        height: z.number().int().min(80).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();
const run = async <A>(effect: Effect.Effect<A, unknown>) => {
  try {
    return await Effect.runPromise(effect);
  } catch {
    throw new Error("Visualization could not be completed. Inspect its work-log entry.");
  }
};
export const GENERATED_VISUALIZATION_INSTRUCTIONS =
  "Cafe supports preview_visualization and publish_visualization for user-requested explanatory interactive HTML. Use a self-contained responsive page with finite work, no network, storage, credentials or privileged APIs. Use asset/<assetId> only for raster attachments already owned by this chat; attachment IDs are opaque, never paths. Preview before publishing. A successful publish result is a private receipt, not a user-visible card; Cafe admits a compact card only after its exact native tool completion. Do not copy source or receipt proofs into ordinary chat. Unsupported hosts fail closed.";

/** The bridge capability fixes the chat/account/session outside model input.
 * Effect's independent strict UTF-8 decoder is the final payload boundary. */
export function registerVisualizationTools(
  server: McpServer,
  service: VisualizationArtifactService,
  authority: VisualizationSessionAuthority,
) {
  server.registerTool(
    "preview_visualization",
    {
      title: "Preview a visualization",
      description: GENERATED_VISUALIZATION_INSTRUCTIONS,
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await run(service.preview(authority, input));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.status,
              width: result.width,
              height: result.height,
              diagnostics: result.diagnostics,
            }),
          },
          { type: "image" as const, data: result.png, mimeType: "image/png" },
        ],
      };
    },
  );
  server.registerTool(
    "publish_visualization",
    {
      title: "Publish a visualization",
      description: GENERATED_VISUALIZATION_INSTRUCTIONS,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const receipt = await run(service.publish(authority, input));
      return {
        structuredContent: { visualizationReceipt: receipt },
        content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
      };
    },
  );
}
