import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const VirtualDesktopId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);
export const VirtualDesktopName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
);
export const DESKTOP_MIN_DIMENSION = 320;
export const DESKTOP_MAX_DIMENSION = 2048;
export const DesktopResolution = Schema.Struct({
  width: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: DESKTOP_MIN_DIMENSION, maximum: DESKTOP_MAX_DIMENSION }),
  ),
  height: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: DESKTOP_MIN_DIMENSION, maximum: DESKTOP_MAX_DIMENSION }),
  ),
});
export type DesktopResolution = typeof DesktopResolution.Type;
export const DEFAULT_DESKTOP_RESOLUTION: DesktopResolution = { width: 1280, height: 800 };
const DesktopCounter = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
/** Volatile, fixed-cardinality totals since this runtime owner started. Never
 * retain tool arguments, image hashes, paths, or per-request histories. */
export const DesktopToolUsage = Schema.Struct({
  calls: DesktopCounter,
  actions: DesktopCounter,
  captures: DesktopCounter,
  screenshots: DesktopCounter,
  screenshotPixels: DesktopCounter,
  unchangedCaptures: DesktopCounter,
  failures: DesktopCounter,
  durationMs: DesktopCounter,
  replyTextChars: DesktopCounter,
});
export type DesktopToolUsage = typeof DesktopToolUsage.Type;
export const VirtualDesktopSnapshot = Schema.Struct({
  id: VirtualDesktopId,
  name: VirtualDesktopName,
  resolution: Schema.optionalKey(DesktopResolution),
  canResize: Schema.optionalKey(Schema.Boolean),
  toolUsage: Schema.optionalKey(DesktopToolUsage),
  state: Schema.Literals(["starting", "ready", "reconnecting", "terminating", "stopped", "failed"]),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  humanControl: Schema.Boolean,
  viewerOpen: Schema.Boolean,
  renderer: Schema.Literals(["gles2", "pixman"]),
  transfer: Schema.Literals(["shared-memory", "dma-buf"]),
  controllingThreadId: Schema.NullOr(ThreadId),
});
export type VirtualDesktopSnapshot = typeof VirtualDesktopSnapshot.Type;

export const VirtualDesktopRequest = Schema.Struct({
  operation: Schema.Literals([
    "status",
    "create",
    "rename",
    "end",
    "set-display",
    "terminate",
    "delete",
    "attach",
    "recheck",
  ]),
  id: Schema.optionalKey(Schema.NullOr(VirtualDesktopId)),
  name: Schema.optionalKey(VirtualDesktopName),
  resolution: Schema.optionalKey(DesktopResolution),
  threadId: Schema.optionalKey(ThreadId),
});
export type VirtualDesktopRequest = typeof VirtualDesktopRequest.Type;

const DesktopComponentStatus = Schema.Literals(["installed", "missing", "unavailable"]);
export const VirtualDesktopPrerequisites = Schema.Struct({
  sway: DesktopComponentStatus,
  xwayland: DesktopComponentStatus,
  dbus: DesktopComponentStatus,
  helper: DesktopComponentStatus,
});
export type VirtualDesktopPrerequisites = typeof VirtualDesktopPrerequisites.Type;

export const VirtualDesktopState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  controlEnabled: Schema.Boolean,
  available: Schema.Boolean,
  defaultResolution: Schema.optionalKey(DesktopResolution),
  // A surviving provider daemon from an older build may omit component details.
  prerequisites: Schema.optionalKey(VirtualDesktopPrerequisites),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  desktops: Schema.Array(VirtualDesktopSnapshot),
  selectedDesktopId: Schema.NullOr(VirtualDesktopId),
  activeDesktopId: Schema.NullOr(VirtualDesktopId),
  selectionPending: Schema.Boolean,
});
export type VirtualDesktopState = typeof VirtualDesktopState.Type;

export class VirtualDesktopError extends Schema.TaggedErrorClass<VirtualDesktopError>()(
  "VirtualDesktopError",
  {
    code: Schema.Literals([
      "unavailable",
      "feature_disabled",
      "not_authorized",
      "not_found",
      "busy",
      "invalid_request",
      "operation_failed",
      "configuration_conflict",
    ]),
    message: Schema.String.check(Schema.isMaxLength(256)),
  },
) {}

export const DesktopViewerAppearance = Schema.Struct({
  dark: Schema.Boolean,
  scale: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 3 })),
});
export type DesktopViewerAppearance = typeof DesktopViewerAppearance.Type;

export const VirtualDesktopConnect = Schema.Struct({
  id: VirtualDesktopId,
  environmentUrl: Schema.String.check(Schema.isMaxLength(2048)),
  appearance: Schema.optionalKey(DesktopViewerAppearance),
});
export type VirtualDesktopConnect = typeof VirtualDesktopConnect.Type;

export const VIRTUAL_DESKTOP_DAEMON_PATH = "/api/provider-daemon/desktops";

export const DesktopObservationRetention = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const DEFAULT_DESKTOP_OBSERVATION_RETENTION = 50;
export const DESKTOP_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
export const DESKTOP_OBSERVATION_PATH = "/api/desktop-observations";
export const DESKTOP_PREVIEW_PATH = "/api/virtual-desktops/previews";
export const DESKTOP_PREVIEW_MAX_BYTES = 512 * 1024;

/** Only this bounded reference belongs in provider events; PNG bytes are private artifacts. */
export const DesktopObservationReference = Schema.Struct({
  id: VirtualDesktopId,
  capturedAt: IsoDateTime.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter((value) => {
      if (value.length !== 24) return false;
      const time = Date.parse(value);
      return Number.isFinite(time) && new Date(time).toISOString() === value;
    }),
  ),
  width: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8192 })),
  height: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8192 })),
  frame: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  humanControl: Schema.Boolean,
  storage: Schema.Literals(["saved", "disabled", "failed"]),
});
export type DesktopObservationReference = typeof DesktopObservationReference.Type;
