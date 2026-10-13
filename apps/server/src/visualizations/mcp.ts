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
  "Cafe supports preview_visualization and publish_visualization for user-requested explanatory interactive HTML. " +
  "Author an embed-first responsive HTML fragment that belongs directly inside the chat, not a separate app or website shell. " +
  "For analytical answers, publish separate focused chart/table/KPI units interleaved with concise explanatory prose rather than a monolithic dashboard by default; group tightly linked controls/charts when shared state is meaningful, and respect explicit dashboard requests. " +
  "Do not duplicate app/site headers, logos, navigation, heroes, outer rounded panels, bulky outer-panel shadows or a max-width centered landing-page wrapper. " +
  "Keep content-specific headings, chart/table/KPI labels and interactive controls; rich dashboards and other requested visualizations remain supported. " +
  "Default to a transparent, host-default background rather than a forced light/dark page canvas. " +
  "Use the host's --foreground and --background colors; optional palette variables are --muted-foreground, --accent, --accent-foreground and --chart-1 through --chart-6, with local fallbacks when absent. " +
  "Make charts, data marks, selection and hover states vivid and colorful using the host's accent/chart palette as anchors for the current light/dark theme; cyan-to-blue-to-violet-to-magenta accents are welcome where compatible. " +
  "Animate colorful charts by default with brief, finite entrance and interaction/hover/selection transitions, only while active and visible; respect static reduced-motion fallbacks rather than making chart motion optional. Play the entrance once per document, not again on scrolling, visibility changes, measurement or resize. Preserve the currently displayed data/transition state during ordinary presentation changes; only an actual filter or selection change starts a fresh data transition. Keep series distinguishable with labels or patterns as well as color and readable contrast. A low-opacity background or scrim must not wash out the actual chart colors. " +
  "Use the same actual offline chat font: Cafe supplies DM Sans Variable (normal/italic Latin and Latin-extended), with --font-sans set to the chat's exact DM Sans/system fallback stack. Use that sans family for ordinary chart text, headings, labels, tooltips, axes and controls; reserve --font-mono and monospace for semantic pre/code/kbd/samp or raw/code details only. Do not default ordinary chart text to monospace or another named font. Keep approximately a 14px base scaled by var(--cafe-interface-scale, 1), with restrained heading sizes and spacing. For canvas text, await document.fonts.ready and derive the family from the unit's computed font-family before measuring/drawing; do not rely on a missing named font, a network font or a fixed monospace canvas font. Native generated hosts install the actual four fixed binary faces before parsing source, while portable generated exports embed the same faces and full license. This changes no external MCP App typography or canvas API. " +
  "On generated-document hosts with Cafe's bundled fluid helper, default to exactly one <canvas data-cafe-fluid aria-hidden=\"true\"></canvas> behind each focused chart unit's content: make the unit position:relative, the canvas position:absolute with inset:0, width:100%, height:100% and pointer-events:none, and layer crisp chart marks/text above it. One document may opt in with at most one canvas[data-cafe-fluid]; publish separate units rather than adding multiple helper canvases to a grouped document. " +
  "That marker opts into the bundled supplied WebGL fluid solver, including its advection, curl/vorticity, pressure solve, shading and cyan/blue/violet/magenta palette/orbit treatment. On a qualified current visibility-lifetime host, the helper keeps moving and follows passive pointer input while visibly active, at no more than 30fps without a five-minute or cumulative frame cutoff; actual offscreen/owner retirement remains host-owned. Older finite-lifetime hosts retain their independently qualified fallback. Do not approximate it with an invented swirl shader or CSS-only substitute, copy/reimplement the engine in source, load it from a network, or override its finite resolution, texture-allocation, resize or frame-rate budgets. No helper script or API call is needed. " +
  "Keep the colorful animated chart data marks separate and usable without WebGL. The bundled fluid uses a display-only 2.0 color gain for stronger visibility. For new chart units, use canvas opacity between 0.8 and 1.0 and a local veil using 60–70% of the theme background, leaving 30–40% transparent; do not stack another heavy overall opacity reduction that makes the fluid disappear. Authored canvas and veil styles independently attenuate the effect, and existing received source is not rewritten. Give only the local fluid decoration a softly blurred, frosted treatment behind that simple translucent theme-aware veil or scrim, with crisp vibrant chart marks and text above it. Never sample the parent/Cafe surface or request screenshot/backdrop access, and avoid heavy full-viewport blur stacks or an outer app/hero shell. " +
  "Give custom tooltip elements role=tooltip or data-cafe-tooltip and theme-backed background, foreground and border using the host's --background, --foreground and --muted-foreground variables with readable local fallbacks; do not hard-code a white tooltip surface in dark mode. Keep tooltip text wrapping within the available chart width rather than creating horizontal overflow. " +
  "Older hosts without the bundled helper and unsupported/context-loss or reduced-motion cases must remain readable with a static local fallback; the canvas marker never supplies the helper to an external MCP App. " +
  "The helper performs bounded static initial poster work while the native presentation hint html[data-cafe-visible] is false, including private previews. For your own chart motion, start animation only when document.documentElement.dataset.cafeVisible === 'true' and document.hidden is false; otherwise stop ongoing animation. Listen for cafe-visibility-changed and visibilitychange, recheck both values before each animation frame, and retain finite settling/frame-rate limits. The initial native hint is false before source parsing and stays false in private previews; it is presentation data only, never a lease, permission or execution-authority claim. " +
  "Do not add a separate full-viewport or heavy perpetual fluid engine. The bundled decoration may sustain its bounded visible motion; your chart's entrance and range/selection/hover transitions must still settle finitely with no idle chart requestAnimationFrame work. Draw only while active and visible, use static reduced-motion or unsupported/context-loss fallbacks, and release any resources/listeners you own on teardown. " +
  "Never hijack scrolling or load CDN fonts/libraries. " +
  "Keep decorative layers pointer-events:none and preserve readable charts, labels and controls. Make decoration static for prefers-reduced-motion:reduce or the host's html[data-cafe-reduced-motion=true] flag, including when that flag changes. " +
  "Use the full available chat-column width: width:100%, max-width:100%, min-width:0 and border-box sizing on chart containers, with responsive wrap/stack layouts that remain usable in narrow panes without horizontal overflow. Reflow long labels and controls, and recalculate chart coordinates from the available width; never require horizontal scrolling, a fixed minimum plot width or a scrolling canvas wrapper. " +
  "For SVG charts, calculate plot coordinates and viewBox from the actual available CSS width and height so text stays crisp at a uniform scale; do not stretch glyphs with preserveAspectRatio=none. Recompute on measured resize, keep labels readable, and animate range filters, paths and KPI values together with brief finite transitions (about 650ms), not abrupt data swaps. " +
  "Use natural normal-flow unit height that includes the entire chart, labels, controls and footer, not a fixed viewport-sized root, 100vh wrapper or document-level overflow:auto/scroll. Avoid nested root or fixed-height scrolling panels and do not merely hide a scrollbar while clipping content; the host conversation should own ordinary scrolling. On qualified current generated-document hosts, bounded normal-flow content height is measured by the host for inline layout; older hosts retain their admitted viewport fallback. Keep tall or dense dashboards within finite layout bounds or use progressive disclosure and explicit host-owned expansion, never parent access or automatic self-expansion. " +
  "Use self-contained content with finite work, no network, storage, credentials or privileged APIs. " +
  "Use asset/<assetId> only for raster attachments already owned by this chat; attachment IDs are opaque, never paths. " +
  "Preview before publishing. A successful publish result is a private receipt, not a user-visible card; Cafe admits a compact card only after its exact native tool completion. " +
  "On a qualified automatic viewport host, generated units activate when visibly admitted to its bounded multi-view pool; older or unavailable hosts retain inert posters and only any independently qualified manual fallback. " +
  "Publishing never grants provider, network or tool authority. External MCP Apps still require explicit activation and exact-operation consent; expansion remains a host-owned user action. " +
  "Do not copy source or receipt proofs into ordinary chat. Unsupported hosts fail closed.";

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
