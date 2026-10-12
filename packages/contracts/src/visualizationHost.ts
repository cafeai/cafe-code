import * as Schema from "effect/Schema";

import {
  GeneratedVisualizationSourceText,
  GeneratedVisualizationViewport,
} from "./visualizations.ts";
import { PngBytesSchema } from "./imageExport.ts";
import { McpAppPreviewReplay } from "./mcpApps.ts";

/** Private local broker discovery. Never return this credential through a renderer API. */
export const VISUALIZATION_HOST_FILE = "visualization-host.json";
export const VISUALIZATION_HOST_VERSION = 1;
export const VISUALIZATION_HOST_PATH = "/visualizations";
export const VISUALIZATION_HOST_MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const VISUALIZATION_HOST_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const VISUALIZATION_HOST_MAX_MESSAGE_BYTES = 128 * 1024;
export const VISUALIZATION_HOST_PREVIEW_MS = 20_000;
export const VISUALIZATION_HOST_ACTIVE_MS = 5 * 60_000;
export const VISUALIZATION_HOST_TICKET_MS = 60_000;
export const VISUALIZATION_HOST_RETIRE_MS = 5_000;
export const VISUALIZATION_HOST_SUSPEND_MS = 30_000;

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const uuid = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[a-f0-9-]{36}$/));
const capability = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ownerId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const appearance = Schema.Literals(["light", "dark"]);
export const VisualizationHostDisplayMode = Schema.Literals(["inline", "fullscreen"]);
export type VisualizationHostDisplayMode = typeof VisualizationHostDisplayMode.Type;
const timestamp = integer(0, Number.MAX_SAFE_INTEGER);
const color = Schema.String.check(
  Schema.isMaxLength(96),
  Schema.isPattern(
    /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([0-9a-z.% ,+/-]+\))$/i,
  ),
);
export const VisualizationHostPresentation = Schema.Struct({
  locale: Schema.Literals(["en", "ja", "ko"]),
  reducedMotion: Schema.Boolean,
  scale: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2 })),
  colors: Schema.Struct({
    background: color,
    foreground: color,
    muted: color,
    accent: color,
    accentForeground: color,
    chart1: color,
    chart2: color,
    chart3: color,
    chart4: color,
    chart5: color,
    chart6: color,
  }).annotate(strict),
}).annotate(strict);
export type VisualizationHostPresentation = typeof VisualizationHostPresentation.Type;

export const VisualizationHostConnection = Schema.Struct({
  version: Schema.Literal(VISUALIZATION_HOST_VERSION),
  generation: uuid,
  url: Schema.String.check(
    Schema.isPattern(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/visualizations$/),
  ),
  token: capability,
}).annotate(strict);
export type VisualizationHostConnection = typeof VisualizationHostConnection.Type;

/** Exact authenticated backend ownership, not a model-selected selector. */
export const VisualizationHostOwner = Schema.Struct({
  environmentId: ownerId,
  threadId: ownerId,
  operationId: uuid,
}).annotate(strict);
export type VisualizationHostOwner = typeof VisualizationHostOwner.Type;

export const VisualizationHostAsset = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
  mime: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  // The independent native decoder checks canonical encoding, byte/pixel bounds
  // and the real format. This spelling is not evidence that bytes are an image.
  base64: Schema.String.check(
    Schema.isMaxLength(Math.ceil(VISUALIZATION_HOST_MAX_ASSET_BYTES / 3) * 4),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
}).annotate(strict);
export const VisualizationHostDocument = Schema.Struct({
  kind: Schema.Literals(["generated", "mcp-app"]),
  html: GeneratedVisualizationSourceText,
  assets: Schema.Array(VisualizationHostAsset).check(Schema.isMaxLength(16)),
  width: GeneratedVisualizationViewport.fields.width,
  height: GeneratedVisualizationViewport.fields.height,
  appearance,
}).annotate(strict);
export type VisualizationHostDocument = typeof VisualizationHostDocument.Type;

export const VisualizationHostReason = Schema.Literals([
  "busy",
  "invalid",
  "expired",
  "unavailable",
  "timeout",
  "resource-denied",
  "capture-failed",
  "retirement-uncertain",
  "owner-revoked",
]);
export type VisualizationHostReason = typeof VisualizationHostReason.Type;
export const VisualizationHostBlocked = Schema.Struct({
  status: Schema.Literal("blocked"),
  reason: VisualizationHostReason,
}).annotate(strict);
export type VisualizationHostBlocked = typeof VisualizationHostBlocked.Type;
export const VisualizationHostPrepared = Schema.Struct({
  status: Schema.Literal("ready"),
  ticket: capability,
  expiresAtMs: timestamp,
}).annotate(strict);
export type VisualizationHostPrepared = typeof VisualizationHostPrepared.Type;
export const VisualizationHostPreview = Schema.Struct({
  status: Schema.Literal("ready"),
  png: Schema.String.check(Schema.isMaxLength(24 * 1024 * 1024)),
  width: integer(1, 1600),
  height: integer(1, 2000),
  diagnostics: Schema.Array(VisualizationHostReason).check(Schema.isMaxLength(20)),
}).annotate(strict);
export type VisualizationHostPreview = typeof VisualizationHostPreview.Type;
export const VisualizationHostPrepareInput = Schema.Struct({
  ticket: capability,
  owner: VisualizationHostOwner,
  document: VisualizationHostDocument,
}).annotate(strict);
export const VisualizationHostPreviewInput = Schema.Struct({
  owner: VisualizationHostOwner,
  document: VisualizationHostDocument,
  // Private data-only poster replay never enters saved documents or viewer IPC.
  previewReplay: Schema.optionalKey(McpAppPreviewReplay),
})
  .check(
    Schema.makeFilter(
      (value) => (value.document.kind === "mcp-app") === (value.previewReplay !== undefined),
    ),
  )
  .annotate(strict);
export const VisualizationHostInspectInput = Schema.Struct({
  ticket: capability,
  leaseId: uuid,
}).annotate(strict);
export const VisualizationHostRevokeInput = Schema.Struct({
  owner: VisualizationHostOwner,
}).annotate(strict);

/** Renderer geometry is finite DIP data; native main clamps it to its exact owning window. */
export const VisualizationHostBounds = Schema.Struct({
  x: integer(-32_768, 32_768),
  y: integer(-32_768, 32_768),
  width: integer(1, 1600),
  height: integer(1, 2000),
}).annotate(strict);
export type VisualizationHostBounds = typeof VisualizationHostBounds.Type;
export const VisualizationHostOpenInput = Schema.Struct({
  ticket: capability,
  bounds: VisualizationHostBounds,
  appearance,
  presentation: Schema.optionalKey(VisualizationHostPresentation),
  displayMode: Schema.optionalKey(VisualizationHostDisplayMode),
}).annotate(strict);
export type VisualizationHostOpenInput = typeof VisualizationHostOpenInput.Type;
export const VisualizationHostLeaseInput = Schema.Struct({ leaseId: uuid }).annotate(strict);
export const VisualizationHostUpdateInput = Schema.Struct({
  leaseId: uuid,
  bounds: VisualizationHostBounds,
  visible: Schema.Boolean,
  appearance,
  presentation: Schema.optionalKey(VisualizationHostPresentation),
  displayMode: Schema.optionalKey(VisualizationHostDisplayMode),
}).annotate(strict);
export type VisualizationHostUpdateInput = typeof VisualizationHostUpdateInput.Type;
export const VisualizationHostMessageInput = Schema.Struct({
  leaseId: uuid,
  json: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(VISUALIZATION_HOST_MAX_MESSAGE_BYTES),
  ),
}).annotate(strict);
export const VisualizationHostState = Schema.Struct({
  leaseId: uuid,
  state: Schema.Literals(["active", "retired", "quarantined", "blocked"]),
  expiresAtMs: timestamp,
  reason: Schema.optionalKey(VisualizationHostReason),
}).annotate(strict);
export type VisualizationHostState = typeof VisualizationHostState.Type;
export const VisualizationHostEvent = Schema.Struct({
  leaseId: uuid,
  state: Schema.Literals(["active", "retired", "quarantined", "message"]),
  json: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(VISUALIZATION_HOST_MAX_MESSAGE_BYTES)),
  ),
  reason: Schema.optionalKey(VisualizationHostReason),
}).annotate(strict);
export type VisualizationHostEvent = typeof VisualizationHostEvent.Type;
export const VisualizationHostInspection = Schema.Struct({
  leaseId: uuid,
  documentGeneration: uuid,
  expiresAtMs: timestamp,
  state: Schema.Literals(["active", "suspended"]),
}).annotate(strict);
export type VisualizationHostInspection = typeof VisualizationHostInspection.Type;
export const VisualizationHostCapture = Schema.Struct({
  png: PngBytesSchema,
  width: integer(1, 1600),
  height: integer(1, 2000),
}).annotate(strict);
export type VisualizationHostCapture = typeof VisualizationHostCapture.Type;
export const VisualizationHostCapabilities = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.Literals(["ready", "unavailable", "quarantined"]),
  maxActive: Schema.Literal(1),
  activeLeaseMs: Schema.Literal(VISUALIZATION_HOST_ACTIVE_MS),
}).annotate(strict);
export type VisualizationHostCapabilities = typeof VisualizationHostCapabilities.Type;
export const VisualizationHostSuspendInput = Schema.Struct({
  leaseId: uuid,
  suspended: Schema.Boolean,
  consentId: uuid,
}).annotate(strict);

/** Optional only for older desktop clients, never emulated by an ordinary browser iframe. */
export interface VisualizationDesktopBridge {
  getVisualizationHostCapabilities?: () => Promise<VisualizationHostCapabilities>;
  openVisualization?: (input: VisualizationHostOpenInput) => Promise<VisualizationHostState>;
  updateVisualization?: (input: VisualizationHostUpdateInput) => Promise<VisualizationHostState>;
  retireVisualization?: (
    input: typeof VisualizationHostLeaseInput.Type,
  ) => Promise<VisualizationHostState>;
  captureVisualization?: (
    input: typeof VisualizationHostLeaseInput.Type,
  ) => Promise<VisualizationHostCapture | null>;
  sendVisualizationMessage?: (input: typeof VisualizationHostMessageInput.Type) => Promise<boolean>;
  suspendVisualization?: (input: typeof VisualizationHostSuspendInput.Type) => Promise<boolean>;
  onVisualizationHostEvent?: (listener: (event: VisualizationHostEvent) => void) => () => void;
}
