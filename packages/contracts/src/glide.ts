import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const GlideBundleId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/),
);
export const GlideControlInput = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    action: Schema.Literal("set-enabled"),
    enabled: Schema.Boolean,
  }).annotate(strict),
  Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "status",
      "open-accessibility",
      "open-screen-recording",
      "reveal-host-app",
    ]),
  }).annotate(strict),
  Schema.Struct({ threadId: ThreadId, action: Schema.Literal("stop") }).annotate(strict),
  Schema.Struct({
    threadId: ThreadId,
    action: Schema.Literal("configure"),
    enabled: Schema.Boolean,
    apps: Schema.Array(GlideBundleId).check(Schema.isMaxLength(16)),
  }).annotate(strict),
]);
export type GlideControlInput = typeof GlideControlInput.Type;
export const GlideControlResult = Schema.Struct({
  available: Schema.Boolean,
  connected: Schema.Boolean,
  enabled: Schema.Boolean,
  fullAccess: Schema.Boolean,
  busy: Schema.Boolean,
  paused: Schema.Boolean,
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
  apps: Schema.Array(GlideBundleId).check(Schema.isMaxLength(16)),
  runningApps: Schema.Array(Schema.Struct({ name: Schema.String, bundleId: GlideBundleId })).check(
    Schema.isMaxLength(256),
  ),
  message: Schema.String,
  /** The app bundle macOS privacy settings must list for Glide, as reported by
   * the trusted native helper (TCC responsible process) or the host executable.
   * Absent when an older owner runtime or helper cannot determine it. */
  hostApp: Schema.optional(
    Schema.Struct({
      path: Schema.String.check(Schema.isMaxLength(1024)),
      name: Schema.String.check(Schema.isMaxLength(128)),
      bundleId: Schema.optional(GlideBundleId),
    }),
  ),
  /** Host macOS major version, used only to label Settings panes. */
  osMajorVersion: Schema.optional(Schema.Int),
});
export type GlideControlResult = typeof GlideControlResult.Type;
export class GlideError extends Schema.TaggedErrorClass<GlideError>()("GlideError", {
  message: Schema.String,
}) {}
