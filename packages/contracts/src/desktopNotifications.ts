import * as Schema from "effect/Schema";

/** Write-only notification data; no URLs, native actions or executable callbacks. */
export const DesktopNotificationInput = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(256)),
  body: Schema.String.check(Schema.isMaxLength(1024)),
  tag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export type DesktopNotificationInput = typeof DesktopNotificationInput.Type;

// Electron's macOS `show` event means the OS accepted the request. Focus and
// notification settings can still suppress its banner; it is not sight proof.
export const DesktopNotificationResult = Schema.Literals([
  "sent",
  "failed",
  "unsupported",
  "cancelled",
]);
export type DesktopNotificationResult = typeof DesktopNotificationResult.Type;
