import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// These transport schemas define browser messages only. Decoding a message does
// not authorize a URL, origin, tab, thread, provider, or snapshot target. The
// native browser and agent bridge must enforce ownership and current grants.
export const EMBEDDED_BROWSER_MAX_URL_CHARS = 4_096;
export const EMBEDDED_BROWSER_MAX_TABS = 8;
export const EMBEDDED_BROWSER_MAX_TYPE_CHARS = 4_096;
export const EMBEDDED_BROWSER_MAX_SNAPSHOT_TEXT_CHARS = 24_000;
export const EMBEDDED_BROWSER_MAX_SNAPSHOT_TARGETS = 200;
export const EMBEDDED_BROWSER_MAX_IMAGE_REGIONS = 100;
export const EMBEDDED_BROWSER_OCR_MAX_CAPTURE_EDGE = 4_096;
export const EMBEDDED_BROWSER_OCR_MAX_CAPTURE_PIXELS = 16_777_216;
export const EMBEDDED_BROWSER_OCR_MAX_INPUT_EDGE = 2_048;
export const EMBEDDED_BROWSER_OCR_MAX_INPUT_PIXELS = 2_097_152;
export const EMBEDDED_BROWSER_OCR_MAX_PNG_BYTES = 8 * 1_024 * 1_024;
export const EMBEDDED_BROWSER_OCR_TIMEOUT_MS = 30_000;
export const AGENT_BROWSER_GRANT_MIN_SECONDS = 60;
export const AGENT_BROWSER_GRANT_MAX_SECONDS = 600;
export const AGENT_BROWSER_GRANT_DEFAULT_SECONDS = 300;
export const AGENT_BROWSER_MAX_REQUESTS_PER_GRANT = 40;
export const AGENT_BROWSER_MAX_QUEUED_REQUESTS = 4;
export const AGENT_BROWSER_REQUEST_TIMEOUT_MS = 90_000;

// Keep browser deadlines as canonical UTC strings. The shared IsoDateTime
// primitive is intentionally broad and does not validate Date.parse inputs.
const EmbeddedBrowserTimestampSchema = IsoDateTime.check(
  Schema.isMaxLength(24),
  Schema.makeFilter(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  ),
);
const EmbeddedBrowserThreadIdSchema = ThreadId.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);

export const EmbeddedBrowserTabIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type EmbeddedBrowserTabId = typeof EmbeddedBrowserTabIdSchema.Type;

export const EmbeddedBrowserSnapshotIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type EmbeddedBrowserSnapshotId = typeof EmbeddedBrowserSnapshotIdSchema.Type;

export const EmbeddedBrowserTargetIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^e[0-9]+$/),
);
export type EmbeddedBrowserTargetId = typeof EmbeddedBrowserTargetIdSchema.Type;

const EmbeddedBrowserUrlInputSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(EMBEDDED_BROWSER_MAX_URL_CHARS),
);

export const EmbeddedBrowserBoundsSchema = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
});
export type EmbeddedBrowserBounds = typeof EmbeddedBrowserBoundsSchema.Type;

export const EmbeddedBrowserStateSchema = Schema.Struct({
  status: Schema.Literals(["open", "closed"]),
  tabId: Schema.NullOr(EmbeddedBrowserTabIdSchema),
  displayUrl: Schema.String.check(Schema.isMaxLength(EMBEDDED_BROWSER_MAX_URL_CHARS)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  shared: Schema.Boolean,
  sharedOrigin: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type EmbeddedBrowserState = typeof EmbeddedBrowserStateSchema.Type;

export const EmbeddedBrowserOpenInputSchema = Schema.Struct({
  initialUrl: Schema.optionalKey(EmbeddedBrowserUrlInputSchema),
});
export type EmbeddedBrowserOpenInput = typeof EmbeddedBrowserOpenInputSchema.Type;

export const EmbeddedBrowserTabInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
});
export type EmbeddedBrowserTabInput = typeof EmbeddedBrowserTabInputSchema.Type;

export const EmbeddedBrowserSetBoundsInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  bounds: EmbeddedBrowserBoundsSchema,
  visible: Schema.optionalKey(Schema.Boolean),
});
export type EmbeddedBrowserSetBoundsInput = typeof EmbeddedBrowserSetBoundsInputSchema.Type;

export const EmbeddedBrowserShareInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  shared: Schema.Boolean,
});
export type EmbeddedBrowserShareInput = typeof EmbeddedBrowserShareInputSchema.Type;

export const EmbeddedBrowserNavigateInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  url: EmbeddedBrowserUrlInputSchema,
});
export type EmbeddedBrowserNavigateInput = typeof EmbeddedBrowserNavigateInputSchema.Type;

export const EmbeddedBrowserHistoryActionInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  action: Schema.Literals(["back", "forward", "reload", "stop"]),
});
export type EmbeddedBrowserHistoryActionInput = typeof EmbeddedBrowserHistoryActionInputSchema.Type;

export const EmbeddedBrowserSnapshotInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  mode: Schema.Literals(["dom-accessibility", "ocr"]),
  ocrLanguage: Schema.optionalKey(Schema.Literals(["eng", "jpn"])),
});
export type EmbeddedBrowserSnapshotInput = typeof EmbeddedBrowserSnapshotInputSchema.Type;

export const EmbeddedBrowserSnapshotTargetSchema = Schema.Struct({
  targetId: EmbeddedBrowserTargetIdSchema,
  role: Schema.String.check(Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  text: Schema.String.check(Schema.isMaxLength(1_024)),
  sensitive: Schema.Boolean,
});
export type EmbeddedBrowserSnapshotTarget = typeof EmbeddedBrowserSnapshotTargetSchema.Type;

export const EmbeddedBrowserImageRegionSchema = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  alt: Schema.String.check(Schema.isMaxLength(1_024)),
  labelledBy: Schema.String.check(Schema.isMaxLength(1_024)),
});
export type EmbeddedBrowserImageRegion = typeof EmbeddedBrowserImageRegionSchema.Type;

export const EmbeddedBrowserOcrResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    engine: Schema.String.check(Schema.isMaxLength(128)),
    language: Schema.Literals(["eng", "jpn"]),
    confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    truncated: Schema.Boolean,
    text: Schema.String.check(Schema.isMaxLength(EMBEDDED_BROWSER_MAX_SNAPSHOT_TEXT_CHARS)),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.String.check(Schema.isMaxLength(512)),
  }),
]);
export type EmbeddedBrowserOcrResult = typeof EmbeddedBrowserOcrResultSchema.Type;

export const EmbeddedBrowserSnapshotSchema = Schema.Struct({
  snapshotId: EmbeddedBrowserSnapshotIdSchema,
  mode: Schema.Literals(["dom-accessibility", "ocr"]),
  displayUrl: Schema.String.check(Schema.isMaxLength(EMBEDDED_BROWSER_MAX_URL_CHARS)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  capturedAt: EmbeddedBrowserTimestampSchema,
  text: Schema.String.check(Schema.isMaxLength(EMBEDDED_BROWSER_MAX_SNAPSHOT_TEXT_CHARS)),
  targets: Schema.Array(EmbeddedBrowserSnapshotTargetSchema).check(
    Schema.isMaxLength(EMBEDDED_BROWSER_MAX_SNAPSHOT_TARGETS),
  ),
  imageRegions: Schema.Array(EmbeddedBrowserImageRegionSchema).check(
    Schema.isMaxLength(EMBEDDED_BROWSER_MAX_IMAGE_REGIONS),
  ),
  ocr: Schema.NullOr(EmbeddedBrowserOcrResultSchema),
  redactionNotice: Schema.String.check(Schema.isMaxLength(512)),
});
export type EmbeddedBrowserSnapshot = typeof EmbeddedBrowserSnapshotSchema.Type;

export const EmbeddedBrowserClickInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  snapshotId: EmbeddedBrowserSnapshotIdSchema,
  targetId: EmbeddedBrowserTargetIdSchema,
});
export type EmbeddedBrowserClickInput = typeof EmbeddedBrowserClickInputSchema.Type;

export const EmbeddedBrowserTypeInputSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  snapshotId: EmbeddedBrowserSnapshotIdSchema,
  targetId: EmbeddedBrowserTargetIdSchema,
  value: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(EMBEDDED_BROWSER_MAX_TYPE_CHARS),
  ),
  sensitive: Schema.Boolean,
});
export type EmbeddedBrowserTypeInput = typeof EmbeddedBrowserTypeInputSchema.Type;

export const EmbeddedBrowserActionResultSchema = Schema.Struct({
  status: Schema.Literals(["completed", "denied", "stale", "failed"]),
  message: Schema.String.check(Schema.isMaxLength(512)),
  state: EmbeddedBrowserStateSchema,
});
export type EmbeddedBrowserActionResult = typeof EmbeddedBrowserActionResultSchema.Type;

export const AgentBrowserGrantIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type AgentBrowserGrantId = typeof AgentBrowserGrantIdSchema.Type;

export const AgentBrowserRequestIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type AgentBrowserRequestId = typeof AgentBrowserRequestIdSchema.Type;

export const AgentBrowserGrantInputSchema = Schema.Struct({
  threadId: EmbeddedBrowserThreadIdSchema,
  providerInstanceId: ProviderInstanceId,
  tabId: EmbeddedBrowserTabIdSchema,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  durationSeconds: Schema.Int.check(
    Schema.isBetween({
      minimum: AGENT_BROWSER_GRANT_MIN_SECONDS,
      maximum: AGENT_BROWSER_GRANT_MAX_SECONDS,
    }),
  ),
});
export type AgentBrowserGrantInput = typeof AgentBrowserGrantInputSchema.Type;

export const AgentBrowserSessionContextSchema = Schema.Struct({
  tabId: EmbeddedBrowserTabIdSchema,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  defaultAccess: Schema.optionalKey(Schema.Boolean),
  disabledThreadIds: Schema.optionalKey(
    Schema.Array(EmbeddedBrowserThreadIdSchema).check(Schema.isMaxLength(10_000)),
  ),
});
export type AgentBrowserSessionContext = typeof AgentBrowserSessionContextSchema.Type;

export const AgentBrowserRevokeInputSchema = Schema.Struct({
  reason: Schema.Literals(["operator", "origin-changed", "tab-closed", "thread-changed"]),
  threadId: Schema.optionalKey(EmbeddedBrowserThreadIdSchema),
});
export type AgentBrowserRevokeInput = typeof AgentBrowserRevokeInputSchema.Type;

const AgentBrowserSnapshotActionSchema = Schema.Struct({
  type: Schema.Literal("snapshot"),
});

const AgentBrowserOcrActionSchema = Schema.Struct({
  type: Schema.Literal("ocr"),
  language: Schema.Literals(["eng", "jpn"]),
});

const AgentBrowserNavigateActionSchema = Schema.Struct({
  type: Schema.Literal("navigate"),
  url: EmbeddedBrowserUrlInputSchema,
});

const AgentBrowserClickActionSchema = Schema.Struct({
  type: Schema.Literal("click"),
  snapshotId: EmbeddedBrowserSnapshotIdSchema,
  targetId: EmbeddedBrowserTargetIdSchema,
});

const AgentBrowserTypeActionSchema = Schema.Struct({
  type: Schema.Literal("type"),
  snapshotId: EmbeddedBrowserSnapshotIdSchema,
  targetId: EmbeddedBrowserTargetIdSchema,
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
});

const AgentBrowserHistoryActionSchema = Schema.Struct({
  type: Schema.Literal("history"),
  action: Schema.Literals(["back", "forward", "reload", "stop"]),
});

export const AgentBrowserActionSchema = Schema.Union([
  AgentBrowserSnapshotActionSchema,
  AgentBrowserOcrActionSchema,
  AgentBrowserNavigateActionSchema,
  AgentBrowserClickActionSchema,
  AgentBrowserTypeActionSchema,
  AgentBrowserHistoryActionSchema,
]);
export type AgentBrowserAction = typeof AgentBrowserActionSchema.Type;

export const AgentBrowserRequestSchema = Schema.Struct({
  requestId: AgentBrowserRequestIdSchema,
  grantId: AgentBrowserGrantIdSchema,
  threadId: EmbeddedBrowserThreadIdSchema,
  providerInstanceId: ProviderInstanceId,
  tabId: EmbeddedBrowserTabIdSchema,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  action: AgentBrowserActionSchema,
  summary: Schema.String.check(Schema.isMaxLength(512)),
  createdAt: EmbeddedBrowserTimestampSchema,
  expiresAt: EmbeddedBrowserTimestampSchema,
});
export type AgentBrowserRequest = typeof AgentBrowserRequestSchema.Type;

export const AgentBrowserExecutionResultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: Schema.NullOr(EmbeddedBrowserSnapshotSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("action"),
    result: EmbeddedBrowserActionResultSchema,
  }),
]);
export type AgentBrowserExecutionResult = typeof AgentBrowserExecutionResultSchema.Type;

export const AgentBrowserCompleteInputSchema = Schema.Struct({
  context: AgentBrowserSessionContextSchema,
  requestId: AgentBrowserRequestIdSchema,
  result: AgentBrowserExecutionResultSchema,
});
export type AgentBrowserCompleteInput = typeof AgentBrowserCompleteInputSchema.Type;

const AgentBrowserInactiveGrantStateSchema = Schema.Struct({
  status: Schema.Literal("inactive"),
  reason: Schema.String.check(Schema.isMaxLength(512)),
});

const AgentBrowserActiveGrantStateSchema = Schema.Struct({
  status: Schema.Literal("active"),
  grantId: AgentBrowserGrantIdSchema,
  threadId: EmbeddedBrowserThreadIdSchema,
  providerInstanceId: ProviderInstanceId,
  tabId: EmbeddedBrowserTabIdSchema,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  grantedAt: EmbeddedBrowserTimestampSchema,
  expiresAt: EmbeddedBrowserTimestampSchema,
  requestCount: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: AGENT_BROWSER_MAX_REQUESTS_PER_GRANT }),
  ),
  requestLimit: Schema.Literal(AGENT_BROWSER_MAX_REQUESTS_PER_GRANT),
  pendingAction: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});

export const AgentBrowserGrantStateSchema = Schema.Union([
  AgentBrowserInactiveGrantStateSchema,
  AgentBrowserActiveGrantStateSchema,
]);
export type AgentBrowserGrantState = typeof AgentBrowserGrantStateSchema.Type;

export const AgentBrowserPollResultSchema = Schema.Struct({
  grant: AgentBrowserGrantStateSchema,
  request: Schema.NullOr(AgentBrowserRequestSchema),
});
export type AgentBrowserPollResult = typeof AgentBrowserPollResultSchema.Type;

export const AgentBrowserCompleteResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  grant: AgentBrowserGrantStateSchema,
});
export type AgentBrowserCompleteResult = typeof AgentBrowserCompleteResultSchema.Type;

export class AgentBrowserRpcError extends Schema.TaggedErrorClass<AgentBrowserRpcError>()(
  "AgentBrowserRpcError",
  { reason: Schema.String.check(Schema.isMaxLength(512)) },
) {
  override get message(): string {
    return this.reason;
  }
}
