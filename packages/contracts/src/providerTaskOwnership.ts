import * as Schema from "effect/Schema";

/** Exact provider child identity used by the existing local avatar. This is an
 * opaque presentation seed, not a history route, task-control capability or
 * display label. Never trim/normalize it into a different native identity. */
const ProviderTaskOwnerChildId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}\p{Bidi_Control}]+$/u),
);

/** Optional source ownership for ordinary provider work. Producers mint this
 * outside raw/native tool data only after their existing routing/incarnation
 * checks. Missing is legacy or unavailable evidence, never inferred ownership.
 * Runtime-generation evidence remains separate and is required by consumers;
 * this field cannot grant liveness, controls or native transcript access. */
export const ProviderTaskOwner = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({ type: Schema.Literal("child"), id: ProviderTaskOwnerChildId }),
]);
export type ProviderTaskOwner = typeof ProviderTaskOwner.Type;
