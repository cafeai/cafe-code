/** Small native-owner scalars only. No source, JSON, identity, URL or path field exists. */
export interface VisualizationSurfaceDiagnostics {
  readonly phase:
    | "uncreated"
    | "bootstrap"
    | "admitted"
    | "active"
    | "retiring"
    | "retired"
    | "quarantined";
  readonly rejection:
    | "none"
    | "native-policy"
    | "renderer-separation"
    | "child-frame"
    | "heartbeat-frame"
    | "heartbeat-sequence"
    | "owner-window"
    | "owner-navigation"
    | "renderer-exit"
    | "resource-request"
    | "page-navigation"
    | "heartbeat-missed";
  readonly exclusiveProcess: boolean;
  readonly frameCount: number;
  readonly rendererCount: number;
  readonly gone: boolean;
  readonly destroyed: boolean;
  readonly watchdogArmed: boolean;
  readonly heartbeatMissed: boolean;
  readonly assetBytes: number;
  readonly requestCount: number;
  readonly servedBytes: number;
  readonly captureOutcome:
    | "not-attempted"
    | "native-error"
    | "empty"
    | "oversize"
    | "encoding-error"
    | "ready";
  readonly captureWidth: number;
  readonly captureHeight: number;
  /** Fixed geometry scalars only; positions, page content and native objects stay private. */
  readonly geometryOutcome: "uncommitted" | "full" | "partial" | "refused";
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly clipWidth: number;
  readonly clipHeight: number;
  readonly ownerZoom: number;
  readonly nativeVisibility: "hidden" | "visible" | "unknown";
  readonly visibilityHintSent: "hidden" | "visible" | "not-sent";
  readonly visibilityCommitted: boolean;
  readonly layoutHeight: number;
  readonly layoutConstrained: boolean;
  readonly layoutSequence: number;
  readonly layoutPublications: number;
  readonly layoutRefusals: number;
  readonly layoutRefusal:
    | "none"
    | "owner"
    | "frame"
    | "invalid"
    | "rate"
    | "geometry"
    | "visibility";
}
export interface VisualizationHostDiagnostics {
  readonly available: boolean;
  readonly status: "ready" | "unavailable" | "quarantined";
  readonly activeCount: number;
  readonly pendingViewerCount: number;
  readonly pendingPreviewCount: number;
  readonly retainedInputBytes: number;
  readonly retirementCount: number;
  readonly lastRetirementReason:
    | "none"
    | "busy"
    | "invalid"
    | "expired"
    | "unavailable"
    | "timeout"
    | "resource-denied"
    | "capture-failed"
    | "retirement-uncertain"
    | "owner-revoked";
  readonly native: VisualizationSurfaceDiagnostics | null;
  readonly viewerCount: number;
  readonly previewCount: number;
  readonly nativeWorkCount: number;
  readonly continuationCount: number;
  /** A finite failure classification, not a received exception or authority. */
  readonly failureCount: number;
  readonly lastFailure: VisualizationFailureDiagnostics | null;
  /** The first pool quarantine is immutable even if a sibling later retires. */
  readonly quarantine: VisualizationQuarantineDiagnostics | null;
}

export interface VisualizationFailureDiagnostics {
  readonly lane: "viewer" | "preview";
  readonly stage: "create" | "initialize" | "install" | "capture" | "retire";
  readonly outcome: "exception" | "deadline" | "refused";
  /** Observed against the original monotonic operation allowance, never inferred from a timer. */
  readonly allowanceSpent: boolean;
}

export interface VisualizationQuarantineDiagnostics {
  readonly stage: "create" | "retire";
  readonly reason: "create-failed" | "retirement-uncertain";
  readonly failure: VisualizationFailureDiagnostics;
  /** A copied scalar snapshot of the exact quarantining record, not a native reference. */
  readonly native: VisualizationSurfaceDiagnostics | null;
}

type ScalarRule = (value: unknown) => boolean;
const member =
  (...values: readonly string[]): ScalarRule =>
  (value) =>
    typeof value === "string" && values.includes(value);
const boolean: ScalarRule = (value) => typeof value === "boolean";
const integer =
  (maximum = Number.MAX_SAFE_INTEGER): ScalarRule =>
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const finite =
  (maximum: number): ScalarRule =>
  (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;

/** Read own data descriptors only. Even an attached serializer/getter must not
 * run while constructing debug output. Additional legacy top-level producer
 * fields are discarded; the native and new nested tuples have an exact shape. */
function dataRecord(
  value: unknown,
  keys: readonly string[],
  exact: boolean,
  defaults: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.includes("toJSON") || names.some((name) => !("value" in descriptors[name]!)))
    return null;
  if (exact && (names.length !== keys.length || names.some((name) => !keys.includes(name))))
    return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor && Object.hasOwn(defaults, key)) {
      result[key] = defaults[key];
      continue;
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function scalarRecord<T>(value: unknown, rules: Record<keyof T & string, ScalarRule>): T | null {
  const fields = Object.keys(rules) as (keyof T & string)[];
  const record = dataRecord(value, fields, true);
  if (!record || fields.some((field) => !rules[field](record[field]))) return null;
  return record as T;
}

const surfaceRules: Record<keyof VisualizationSurfaceDiagnostics, ScalarRule> = {
  phase: member(
    "uncreated",
    "bootstrap",
    "admitted",
    "active",
    "retiring",
    "retired",
    "quarantined",
  ),
  rejection: member(
    "none",
    "native-policy",
    "renderer-separation",
    "child-frame",
    "heartbeat-frame",
    "heartbeat-sequence",
    "owner-window",
    "owner-navigation",
    "renderer-exit",
    "resource-request",
    "page-navigation",
    "heartbeat-missed",
  ),
  exclusiveProcess: boolean,
  frameCount: integer(1024),
  rendererCount: integer(1024),
  gone: boolean,
  destroyed: boolean,
  watchdogArmed: boolean,
  heartbeatMissed: boolean,
  assetBytes: integer(8 * 1024 * 1024),
  requestCount: integer(),
  servedBytes: integer(),
  captureOutcome: member(
    "not-attempted",
    "native-error",
    "empty",
    "oversize",
    "encoding-error",
    "ready",
  ),
  captureWidth: integer(1600),
  captureHeight: integer(2000),
  geometryOutcome: member("uncommitted", "full", "partial", "refused"),
  viewportWidth: integer(1600),
  viewportHeight: integer(2000),
  clipWidth: integer(1600),
  clipHeight: integer(2000),
  ownerZoom: finite(Number.MAX_SAFE_INTEGER),
  nativeVisibility: member("hidden", "visible", "unknown"),
  visibilityHintSent: member("hidden", "visible", "not-sent"),
  visibilityCommitted: boolean,
  layoutHeight: integer(2000),
  layoutConstrained: boolean,
  layoutSequence: integer(100000),
  layoutPublications: integer(),
  layoutRefusals: integer(),
  layoutRefusal: member("none", "owner", "frame", "invalid", "rate", "geometry", "visibility"),
};

/** Independent copying is also used before freezing the first quarantine.
 * Returning null means diagnostic uncertainty, never healthy native cleanup. */
export function copyVisualizationSurfaceDiagnostics(
  value: unknown,
): VisualizationSurfaceDiagnostics | null {
  try {
    return scalarRecord<VisualizationSurfaceDiagnostics>(value, surfaceRules);
  } catch {
    return null;
  }
}

const failureRules: Record<keyof VisualizationFailureDiagnostics, ScalarRule> = {
  lane: member("viewer", "preview"),
  stage: member("create", "initialize", "install", "capture", "retire"),
  outcome: member("exception", "deadline", "refused"),
  allowanceSpent: boolean,
};
function copyFailure(value: unknown): VisualizationFailureDiagnostics | null {
  return scalarRecord<VisualizationFailureDiagnostics>(value, failureRules);
}

function copyQuarantine(value: unknown): VisualizationQuarantineDiagnostics | null {
  const record = dataRecord(value, ["stage", "reason", "failure", "native"], true);
  if (
    !record ||
    !member("create", "retire")(record.stage) ||
    !member("create-failed", "retirement-uncertain")(record.reason)
  )
    return null;
  const failure = copyFailure(record.failure);
  const native = record.native === null ? null : copyVisualizationSurfaceDiagnostics(record.native);
  if (!failure || (record.native !== null && !native)) return null;
  if ((record.stage === "create") !== (record.reason === "create-failed")) return null;
  return {
    stage: record.stage as VisualizationQuarantineDiagnostics["stage"],
    reason: record.reason as VisualizationQuarantineDiagnostics["reason"],
    failure,
    native,
  };
}

const hostRules = {
  available: boolean,
  status: member("ready", "unavailable", "quarantined"),
  activeCount: integer(5),
  pendingViewerCount: integer(4),
  pendingPreviewCount: integer(2),
  retainedInputBytes: integer(64 * 1024 * 1024),
  retirementCount: integer(),
  lastRetirementReason: member(
    "none",
    "busy",
    "invalid",
    "expired",
    "unavailable",
    "timeout",
    "resource-denied",
    "capture-failed",
    "retirement-uncertain",
    "owner-revoked",
  ),
  viewerCount: integer(4),
  previewCount: integer(1),
  nativeWorkCount: integer(6),
  continuationCount: integer(4),
  failureCount: integer(),
} satisfies Partial<Record<keyof VisualizationHostDiagnostics, ScalarRule>>;

// Old/unavailable local producers may omit only these new diagnostic fields.
// A supplied malformed value is never converted into a reassuring default.
type LegacyVisualizationHostDiagnostics = Omit<
  VisualizationHostDiagnostics,
  "failureCount" | "lastFailure" | "quarantine"
>;
let reader: (() => VisualizationHostDiagnostics | LegacyVisualizationHostDiagnostics) | null = null;
/** Registration is scoped to the actual main-owned host, never a renderer/RPC publication. */
export function registerVisualizationDiagnostics(
  next: () => VisualizationHostDiagnostics | LegacyVisualizationHostDiagnostics,
): () => void {
  reader = next;
  return () => {
    if (reader === next) reader = null;
  };
}
/** Evaluated only on existing debug requests; no new sampler, history or timer. */
export function readVisualizationDiagnostics(): VisualizationHostDiagnostics | null {
  try {
    const value = reader?.();
    if (!value) return null;
    const fields = Object.keys(hostRules) as (keyof typeof hostRules)[];
    const record = dataRecord(value, [...fields, "native", "lastFailure", "quarantine"], false, {
      failureCount: 0,
      lastFailure: null,
      quarantine: null,
    });
    if (!record || fields.some((field) => !hostRules[field](record[field]))) return null;
    const native =
      record.native === null ? null : copyVisualizationSurfaceDiagnostics(record.native);
    const lastFailure = record.lastFailure === null ? null : copyFailure(record.lastFailure);
    const quarantine = record.quarantine === null ? null : copyQuarantine(record.quarantine);
    if (
      (record.native !== null && !native) ||
      (record.lastFailure !== null && !lastFailure) ||
      (record.quarantine !== null && !quarantine)
    )
      return null;
    // Explicit projection prevents a future producer's extra private fields
    // from silently appearing in either compact or full debug responses.
    return {
      ...Object.fromEntries(fields.map((field) => [field, record[field]])),
      native,
      lastFailure,
      quarantine,
    } as VisualizationHostDiagnostics;
  } catch {
    return null;
  }
}
