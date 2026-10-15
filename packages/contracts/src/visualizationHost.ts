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
export const VISUALIZATION_HOST_MAX_VIEWERS = 4;
export const VISUALIZATION_HOST_MAX_INPUT_BYTES = 64 * 1024 * 1024;

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
/** Authenticated backend cancellation releases only this unused ticket. */
export const VisualizationHostDiscardInput = Schema.Struct({ ticket: capability }).annotate(strict);
export const VisualizationHostDiscardResult = Schema.Struct({ discarded: Schema.Boolean }).annotate(
  strict,
);

/** Trusted owner-page CSS geometry, not native DIP or physical raster pixels.
 * Main alone reads the exact owning WebContents zoom and maps it into its View
 * coordinate system. The full viewport must not shrink when history scrolls. */
export const VisualizationHostBounds = Schema.Struct({
  x: integer(-32_768, 32_768),
  y: integer(-32_768, 32_768),
  width: integer(1, 1600),
  height: integer(1, 2000),
}).annotate(strict);
export type VisualizationHostBounds = typeof VisualizationHostBounds.Type;
const clipIsSubset = (value: {
  readonly bounds: VisualizationHostBounds;
  readonly clipBounds?: VisualizationHostBounds;
}) => {
  const clip = value.clipBounds;
  const bounds = value.bounds;
  return (
    !clip ||
    (clip.x >= bounds.x &&
      clip.y >= bounds.y &&
      clip.x + clip.width <= bounds.x + bounds.width &&
      clip.y + clip.height <= bounds.y + bounds.height)
  );
};
export const VisualizationHostOpenInput = Schema.Struct({
  ticket: capability,
  bounds: VisualizationHostBounds,
  // Visible card/scroll-area intersection, separate from the full page viewport.
  // Older native callers and private previews omit it to request the full bounds.
  clipBounds: Schema.optionalKey(VisualizationHostBounds),
  appearance,
  presentation: Schema.optionalKey(VisualizationHostPresentation),
  displayMode: Schema.optionalKey(VisualizationHostDisplayMode),
  // Native-owned, one-use source/window/frame continuation; never a fresh lease budget.
  continuation: Schema.optionalKey(capability),
})
  .check(Schema.makeFilter(clipIsSubset))
  .annotate(strict);
export type VisualizationHostOpenInput = typeof VisualizationHostOpenInput.Type;
export const VisualizationHostLeaseInput = Schema.Struct({ leaseId: uuid }).annotate(strict);
export const VisualizationHostUpdateInput = Schema.Struct({
  leaseId: uuid,
  bounds: VisualizationHostBounds,
  clipBounds: Schema.optionalKey(VisualizationHostBounds),
  visible: Schema.Boolean,
  appearance,
  presentation: Schema.optionalKey(VisualizationHostPresentation),
  displayMode: Schema.optionalKey(VisualizationHostDisplayMode),
  // Explicit trusted fullscreen interaction only; automatic admission omits it.
  focus: Schema.optionalKey(Schema.Boolean),
  // Generated-only presentation hiding for a positive crop/menu; never Apps
  // consent or authority to retain a genuinely offscreen/hidden owner.
  presentationHidden: Schema.optionalKey(Schema.Boolean),
})
  .check(Schema.makeFilter(clipIsSubset))
  .annotate(strict);
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
  // Null is exact generated visibility-owned lifetime, not an infinite ticket.
  expiresAtMs: Schema.NullOr(timestamp),
  reason: Schema.optionalKey(VisualizationHostReason),
}).annotate(strict);
export type VisualizationHostState = typeof VisualizationHostState.Type;
/** Adversarial presentation data, never execution or provider authority. */
export const VisualizationHostLayout = Schema.Struct({
  height: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 80, maximum: 2000 })),
  constrained: Schema.Boolean,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100000 })),
}).annotate(strict);
export type VisualizationHostLayout = typeof VisualizationHostLayout.Type;
export const VisualizationHostEvent = Schema.Struct({
  leaseId: uuid,
  // Transient echo of this window's consumed opening ticket, never a broker credential.
  openingTicket: Schema.optionalKey(capability),
  state: Schema.Literals(["active", "retired", "quarantined", "message", "wheel", "layout"]),
  layout: Schema.optionalKey(VisualizationHostLayout),
  json: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(VISUALIZATION_HOST_MAX_MESSAGE_BYTES)),
  ),
  reason: Schema.optionalKey(VisualizationHostReason),
  wheel: Schema.optionalKey(
    Schema.Struct({
      deltaX: Schema.Number.check(Schema.isBetween({ minimum: -2048, maximum: 2048 })),
      deltaY: Schema.Number.check(Schema.isBetween({ minimum: -2048, maximum: 2048 })),
    }).annotate(strict),
  ),
})
  .check(
    Schema.makeFilter(
      (value) =>
        (value.state === "wheel") === (value.wheel !== undefined) &&
        (value.state === "layout") === (value.layout !== undefined) &&
        (value.state === "message" || value.json === undefined),
    ),
  )
  .annotate(strict);
export type VisualizationHostEvent = typeof VisualizationHostEvent.Type;
export const VisualizationHostInspection = Schema.Struct({
  leaseId: uuid,
  documentGeneration: uuid,
  expiresAtMs: Schema.NullOr(timestamp),
  state: Schema.Literals(["active", "suspended"]),
}).annotate(strict);
export type VisualizationHostInspection = typeof VisualizationHostInspection.Type;
export const VisualizationHostCapture = Schema.Struct({
  png: PngBytesSchema,
  width: integer(1, 1600),
  height: integer(1, 2000),
}).annotate(strict);
export type VisualizationHostCapture = typeof VisualizationHostCapture.Type;
const legacyCapabilities = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.Literals(["ready", "unavailable", "quarantined"]),
  maxActive: Schema.Literal(1),
  activeLeaseMs: Schema.Literal(VISUALIZATION_HOST_ACTIVE_MS),
}).annotate(strict);
export const VisualizationHostCapabilities = Schema.Union([
  legacyCapabilities,
  Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.Literals(["ready", "unavailable", "quarantined"]),
    poolVersion: Schema.Literal(1),
    autoGenerated: Schema.Literal(true),
    maxActive: Schema.Literal(VISUALIZATION_HOST_MAX_VIEWERS),
    maxMcpApps: Schema.Literal(1),
    maxPreviews: Schema.Literal(1),
    activeLeaseMs: Schema.Literal(VISUALIZATION_HOST_ACTIVE_MS),
  }).annotate(strict),
  Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.Literals(["ready", "unavailable", "quarantined"]),
    poolVersion: Schema.Literal(1),
    autoGenerated: Schema.Literal(true),
    generatedLifecycle: Schema.Literal("visible"),
    maxActive: Schema.Literal(VISUALIZATION_HOST_MAX_VIEWERS),
    maxMcpApps: Schema.Literal(1),
    maxPreviews: Schema.Literal(1),
    // External Apps alone retain this finite document lifetime.
    activeLeaseMs: Schema.Literal(VISUALIZATION_HOST_ACTIVE_MS),
  }).annotate(strict),
]);
export type VisualizationHostCapabilities = typeof VisualizationHostCapabilities.Type;
/** Native counters are scheduling hints, never proof of slot ownership or retirement. */
export const VisualizationHostCapacity = Schema.Struct({
  poolVersion: Schema.Literal(1),
  sequence: timestamp,
  available: Schema.Boolean,
  viewerCount: integer(0, VISUALIZATION_HOST_MAX_VIEWERS),
  freeViewers: integer(0, VISUALIZATION_HOST_MAX_VIEWERS),
  preparedCount: integer(0, VISUALIZATION_HOST_MAX_VIEWERS),
  freePreparations: integer(0, VISUALIZATION_HOST_MAX_VIEWERS),
  mcpAppAvailable: Schema.Boolean,
  previewBusy: Schema.Boolean,
}).annotate(strict);
export type VisualizationHostCapacity = typeof VisualizationHostCapacity.Type;
export const VisualizationHostCapacityObservation = Schema.Struct({
  observing: Schema.Boolean,
  observerId: uuid,
  sequence: timestamp,
}).annotate(strict);
export const VisualizationHostYieldResult = Schema.Struct({
  leaseId: uuid,
  state: VisualizationHostState.fields.state,
  expiresAtMs: Schema.NullOr(timestamp),
  reason: Schema.optionalKey(VisualizationHostReason),
  continuation: Schema.optionalKey(capability),
}).annotate(strict);
export type VisualizationHostYieldResult = typeof VisualizationHostYieldResult.Type;
export const VisualizationHostSuspendInput = Schema.Struct({
  leaseId: uuid,
  suspended: Schema.Boolean,
  consentId: uuid,
}).annotate(strict);

/** Optional only for older desktop clients, never emulated by an ordinary browser iframe. */
export interface VisualizationDesktopBridge {
  focusVisualization?: (input: typeof VisualizationHostLeaseInput.Type) => Promise<boolean>;
  getVisualizationHostCapabilities?: () => Promise<VisualizationHostCapabilities>;
  getVisualizationHostCapacity?: () => Promise<VisualizationHostCapacity>;
  onVisualizationCapacityChanged?: (
    listener: (value: VisualizationHostCapacity) => void,
  ) => () => void;
  openVisualization?: (input: VisualizationHostOpenInput) => Promise<VisualizationHostState>;
  updateVisualization?: (input: VisualizationHostUpdateInput) => Promise<VisualizationHostState>;
  retireVisualization?: (
    input: typeof VisualizationHostLeaseInput.Type,
  ) => Promise<VisualizationHostState>;
  yieldVisualization?: (
    input: typeof VisualizationHostLeaseInput.Type,
  ) => Promise<VisualizationHostYieldResult>;
  beginVisualizationTransition?: (
    input: typeof VisualizationHostLeaseInput.Type,
  ) => Promise<boolean>;
  captureVisualization?: (
    input: typeof VisualizationHostLeaseInput.Type,
  ) => Promise<VisualizationHostCapture | null>;
  sendVisualizationMessage?: (input: typeof VisualizationHostMessageInput.Type) => Promise<boolean>;
  suspendVisualization?: (input: typeof VisualizationHostSuspendInput.Type) => Promise<boolean>;
  onVisualizationHostEvent?: (listener: (event: VisualizationHostEvent) => void) => () => void;
}
