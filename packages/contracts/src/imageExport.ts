import * as Schema from "effect/Schema";

/**
 * Image export is an explicit renderer-to-shell write capability. These limits
 * are shared by rasterization and the independently validating desktop main
 * process so untrusted diagram geometry cannot request an unbounded bitmap.
 */
export const MAX_PNG_BYTES = 32 * 1024 * 1024;
export const MAX_PNG_DIMENSION = 8192;
export const MAX_PNG_PIXELS = 16_777_216;

export const PngBytesSchema = Schema.Uint8Array.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PNG_BYTES),
);

// The renderer supplies only an inert default basename, never a destination
// path. The user's native save dialog remains the sole path authority.
export const PngSuggestedNameSchema = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.png$/u),
);

export const SavePngInputSchema = Schema.Struct({
  png: PngBytesSchema,
  suggestedName: PngSuggestedNameSchema,
});
export type SavePngInput = typeof SavePngInputSchema.Type;

export const SavePngResultSchema = Schema.Literals(["saved", "cancelled", "failed"]);
export type SavePngResult = typeof SavePngResultSchema.Type;
