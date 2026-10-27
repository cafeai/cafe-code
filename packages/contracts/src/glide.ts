import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const GlideStopRevision = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,15})$/));
export const GlideThreadActivity = Schema.Struct({
  state: Schema.Literals([
    "ready",
    "capturing",
    "reading",
    "acting",
    "stopping",
    "stopped",
    "unavailable",
  ]),
  appName: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  windowTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type GlideThreadActivity = typeof GlideThreadActivity.Type;
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
      "activity",
      "open-accessibility",
      "open-screen-recording",
      "reveal-host-app",
    ]),
  }).annotate(strict),
  Schema.Struct({ action: Schema.Literal("stop-all") }).annotate(strict),
  Schema.Struct({
    action: Schema.Literal("presentation"),
    theme: Schema.Literals(["dark", "light"]),
    locale: Schema.Literals(["en", "ja", "ko"]),
    accent: Schema.optional(
      Schema.String.check(Schema.isPattern(/^(#[a-fA-F0-9]{6}|oklch\([0-9.\s%]+\))$/)),
    ),
  }).annotate(strict),
  Schema.Struct({
    action: Schema.Literal("ack-navigation"),
    id: Schema.String.check(Schema.isMaxLength(64)),
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
  stopRevision: Schema.optional(GlideStopRevision),
  activity: Schema.optional(GlideThreadActivity),
  navigation: Schema.optional(Schema.Struct({ id: Schema.String, threadId: ThreadId })),
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
