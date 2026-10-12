import * as Schema from "effect/Schema";

import { MAX_PNG_DIMENSION, MAX_PNG_PIXELS } from "./imageExport.ts";

/**
 * These versioned admission bounds describe data, not host capacity or permission
 * to execute it. Runtime owners must independently enforce transport, storage,
 * native ownership, authorization and resource limits before using these shapes.
 */
export const VISUALIZATION_LIMITS_VERSION = 1;
export const VISUALIZATION_MAX_SOURCE_BYTES = 512 * 1024;
// JSON can escape one source code unit into six ASCII bytes. This separate wire
// bound accommodates the source limit without borrowing the MCP frame budget.
export const VISUALIZATION_MAX_INPUT_JSON_BYTES = 4 * 1024 * 1024;
export const VISUALIZATION_MAX_REFERENCE_JSON_BYTES = 8 * 1024;
export const VISUALIZATION_MAX_BRIDGE_BYTES = 16 * 1024;
export const VISUALIZATION_MAX_ASSETS = 16;
export const VISUALIZATION_MAX_ASSET_MANIFEST_BYTES = 16 * 1024;
export const VISUALIZATION_MAX_TITLE_CHARS = 160;
export const VISUALIZATION_MIN_VIEWPORT_WIDTH = 240;
export const VISUALIZATION_MAX_VIEWPORT_WIDTH = 1600;
export const VISUALIZATION_MIN_VIEWPORT_HEIGHT = 80;
export const VISUALIZATION_MAX_VIEWPORT_HEIGHT = 2000;
export const VISUALIZATION_MAX_DIAGNOSTIC_RECORDS = 20;
export const VISUALIZATION_MAX_DIAGNOSTIC_MESSAGE_CHARS = 500;
export const VISUALIZATION_MAX_DIAGNOSTICS_BYTES = 16 * 1024;

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const version = Schema.Literal(VISUALIZATION_LIMITS_VERSION);
const purpose = Schema.Literal("generated-visualization");
const uuid = Schema.String.check(
  Schema.isUUID(),
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);

/**
 * Count exact UTF-8 without allocating an encoder output for a rejected string.
 * The cheap code-unit bound precedes the bounded scan. Unpaired UTF-16 surrogates
 * are invalid: accepting TextEncoder's replacement would change immutable bytes.
 * This predicate is schema validation only; it does not mint content commitments.
 */
const withinUtf8Bytes = (value: string, maximum: number): boolean => {
  if (value.length > maximum) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > maximum) return false;
  }
  return true;
};

export const VisualizationArtifactId = uuid.pipe(Schema.brand("VisualizationArtifactId"));
export type VisualizationArtifactId = typeof VisualizationArtifactId.Type;
export const VisualizationRevisionId = uuid.pipe(Schema.brand("VisualizationRevisionId"));
export type VisualizationRevisionId = typeof VisualizationRevisionId.Type;
/** Client deduplication data, never provider/native-call attribution or authority. */
export const VisualizationRequestId = uuid.pipe(Schema.brand("VisualizationRequestId"));
export type VisualizationRequestId = typeof VisualizationRequestId.Type;
export const VisualizationGenerationId = uuid.pipe(Schema.brand("VisualizationGenerationId"));
export type VisualizationGenerationId = typeof VisualizationGenerationId.Type;

export const GeneratedVisualizationSourceText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => withinUtf8Bytes(value, VISUALIZATION_MAX_SOURCE_BYTES)),
);
export type GeneratedVisualizationSourceText = typeof GeneratedVisualizationSourceText.Type;

/** Raw bounded wire text only; these shapes do not parse JSON or authorize its payload. */
export const GeneratedVisualizationInputJsonText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => withinUtf8Bytes(value, VISUALIZATION_MAX_INPUT_JSON_BYTES)),
);
export type GeneratedVisualizationInputJsonText = typeof GeneratedVisualizationInputJsonText.Type;
export const GeneratedVisualizationReferenceJsonText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => withinUtf8Bytes(value, VISUALIZATION_MAX_REFERENCE_JSON_BYTES)),
);
export type GeneratedVisualizationReferenceJsonText =
  typeof GeneratedVisualizationReferenceJsonText.Type;
export const GeneratedVisualizationBridgeJsonText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => withinUtf8Bytes(value, VISUALIZATION_MAX_BRIDGE_BYTES)),
);
export type GeneratedVisualizationBridgeJsonText = typeof GeneratedVisualizationBridgeJsonText.Type;

// Display metadata remains exact received text, not an executable CSS/path value.
// Reject controls and directional overrides rather than normalize their meaning.
const title = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(VISUALIZATION_MAX_TITLE_CHARS),
  // oxlint-disable-next-line no-control-regex -- Refuse C0/C1 controls and bidi overrides in exact received titles.
  Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u),
  Schema.makeFilter((value) => value.trim().length > 0 && withinUtf8Bytes(value, 640)),
);
const width = Schema.Int.check(
  Schema.isBetween({
    minimum: VISUALIZATION_MIN_VIEWPORT_WIDTH,
    maximum: VISUALIZATION_MAX_VIEWPORT_WIDTH,
  }),
);
const height = Schema.Int.check(
  Schema.isBetween({
    minimum: VISUALIZATION_MIN_VIEWPORT_HEIGHT,
    maximum: VISUALIZATION_MAX_VIEWPORT_HEIGHT,
  }),
);

export const GeneratedVisualizationViewport = Schema.Struct({ width, height }).annotate(strict);
export type GeneratedVisualizationViewport = typeof GeneratedVisualizationViewport.Type;

/**
 * Attachment IDs use the existing opaque upload spelling, without importing the
 * general attachment's filename/MIME/size fields as producer-selected evidence.
 * Shape admission does not prove attachment ownership, raster type or integrity.
 */
export const GeneratedVisualizationAsset = Schema.Struct({
  assetId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
  attachmentId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z0-9_-]+$/i),
  ),
}).annotate(strict);
export type GeneratedVisualizationAsset = typeof GeneratedVisualizationAsset.Type;

export const GeneratedVisualizationAssets = Schema.Array(GeneratedVisualizationAsset).check(
  Schema.isMaxLength(VISUALIZATION_MAX_ASSETS),
  Schema.makeFilter(
    (assets) => new Set(assets.map((asset) => asset.assetId)).size === assets.length,
  ),
  Schema.makeFilter((assets) =>
    withinUtf8Bytes(JSON.stringify(assets), VISUALIZATION_MAX_ASSET_MANIFEST_BYTES),
  ),
);
export type GeneratedVisualizationAssets = typeof GeneratedVisualizationAssets.Type;

/** No account, chat, native-call, path, URL, network or output selectors are accepted. */
export const GeneratedVisualizationInput = Schema.Struct({
  version,
  purpose,
  requestId: VisualizationRequestId,
  source: GeneratedVisualizationSourceText,
  title,
  assets: GeneratedVisualizationAssets,
  appearance: Schema.Literals(["auto", "light", "dark"]),
  viewport: Schema.optionalKey(GeneratedVisualizationViewport),
}).annotate(strict);
export type GeneratedVisualizationInput = typeof GeneratedVisualizationInput.Type;

const poster = Schema.Struct({
  id: uuid.pipe(Schema.brand("VisualizationPosterId")),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PNG_DIMENSION })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PNG_DIMENSION })),
})
  .check(Schema.makeFilter((value) => value.width * value.height <= MAX_PNG_PIXELS))
  .annotate(strict);

/**
 * Compact immutable display data only. Neither this purpose tag nor schema-valid
 * IDs authenticate publication. Trusted receipt/native-call admission is a
 * separate runtime boundary. Source, private hashes/proofs and diagnostics must
 * never be added to ordinary events, history rows or projected references.
 */
export const GeneratedVisualizationReference = Schema.Struct({
  version,
  purpose,
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  title,
  width,
  height,
  poster: Schema.optionalKey(poster),
}).annotate(strict);
export type GeneratedVisualizationReference = typeof GeneratedVisualizationReference.Type;

/** Separate private bytes shape; authenticated reads and integrity checks remain mandatory. */
export const GeneratedVisualizationSource = Schema.Struct({
  version,
  purpose,
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  source: GeneratedVisualizationSourceText,
  assets: GeneratedVisualizationAssets,
}).annotate(strict);
export type GeneratedVisualizationSource = typeof GeneratedVisualizationSource.Type;

export const VisualizationFailureClassification = Schema.Literals([
  "timeout",
  "resource-denied",
  "asset-missing",
  "bridge-malformed",
  "capture-failed",
  "producer-revoked",
  "host-unavailable",
  "publication-stale",
]);
export type VisualizationFailureClassification = typeof VisualizationFailureClassification.Type;

/**
 * Received diagnostic text may itself contain private content. A schema is not
 * redaction: owners must authenticate explicit inspection and redact secrets
 * before serialization. Never log a Schema issue/cause containing rejected data.
 */
export const GeneratedVisualizationDiagnostics = Schema.Struct({
  version,
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  records: Schema.Array(
    Schema.Struct({
      classification: VisualizationFailureClassification,
      message: Schema.String.check(
        Schema.isMaxLength(VISUALIZATION_MAX_DIAGNOSTIC_MESSAGE_CHARS),
        Schema.makeFilter((value) => withinUtf8Bytes(value, 2000)),
      ),
    }).annotate(strict),
  ).check(Schema.isMaxLength(VISUALIZATION_MAX_DIAGNOSTIC_RECORDS)),
  truncated: Schema.Boolean,
})
  // JSON escaping counts toward the envelope, independently from record count
  // and message length. All nested fields are finite before this serialization.
  .check(
    Schema.makeFilter((value) =>
      withinUtf8Bytes(JSON.stringify(value), VISUALIZATION_MAX_DIAGNOSTICS_BYTES),
    ),
  )
  // Checks create a schema wrapper: attach strict decoding to that final wrapper,
  // not only to the underlying Struct, or excess fields can be silently stripped.
  .annotate(strict);
export type GeneratedVisualizationDiagnostics = typeof GeneratedVisualizationDiagnostics.Type;

const bridgeBinding = {
  version,
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  hostGeneration: VisualizationGenerationId,
  documentGeneration: VisualizationGenerationId,
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
};

/**
 * Presentation observations only, not Apps methods or authority. The receiver
 * must match its exact owned binding/port, enforce monotonic sequence and rates,
 * and clamp geometry to its actual layout. A reported ready/error state proves
 * neither containment nor successful capture/publication/native retirement.
 */
export const GeneratedVisualizationBridgeMessage = Schema.Union([
  Schema.Struct({
    ...bridgeBinding,
    kind: Schema.Literal("document.size"),
    width,
    height,
  }).annotate(strict),
  Schema.Struct({
    ...bridgeBinding,
    kind: Schema.Literal("document.health"),
    status: Schema.Literals(["ready", "render-error"]),
  }).annotate(strict),
]);
export type GeneratedVisualizationBridgeMessage = typeof GeneratedVisualizationBridgeMessage.Type;
