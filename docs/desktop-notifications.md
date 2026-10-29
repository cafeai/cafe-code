# Desktop notifications

Chat completion and user-input notifications use the desktop main process's
Electron `Notification` API through `desktop:show-notification`. They do not use
the renderer's web Notifications API. The shared browser-session permission
policy remains microphone-only; dictation, untrusted frames, received documents
and auxiliary windows gain no notification bridge authority.

The existing desktop IPC boundary validates the registered main window, live
top frame, exact application origin and document revision. Notification input
admits only bounded title/body/tag strings. Native errors and schema failures
produce finite feedback without exposing or coercing raw errors. Each retained
notification belongs to its original native frame and window. Cross-document
navigation, renderer exit, destruction and desktop-scope disposal revoke its
click authority and dismiss its exact native object. Ordinary SPA navigation
retains that same document's authority. Same-owner tags replace prior entries;
the controller retains at most 64 native notification objects across windows.

The independent per-device preferences remain off by default. Enabling either
category attempts a native setup notification before saving the opt-in. Turning
a category off needs no native delivery. Settings → Notifications also offers
**Send test notification**, which never changes either preference. Failed setup
leaves the preference unchanged; a result after the settings page unmounts
cannot save it. A ten-second scheduling deadline bounds each IPC request;
expiration retires the exact pending native object without retrying it.

The pinned Electron 43.8.4 macOS notification presenter requests native alert,
sound and badge authorization when first created. Its `show` event means that
the OS accepted scheduling, not that a banner was visible. Focus/Do Not Disturb,
system notification style and OS authorization remain native decisions. Settings
therefore reports that a notification was **sent**, with system-settings guidance,
rather than claiming delivery or permission. macOS requires a signed app for
this Electron native notification API. An unsigned source app can fail despite
the bridge being correctly wired; do not change signing, profiles or system
preferences to conceal that result. Upstream implementation references:
[presenter authorization](https://github.com/electron/electron/blob/v43.8.4/shell/browser/notifications/mac/notification_presenter_mac.mm)
and [native scheduling callback](https://github.com/electron/electron/blob/v43.8.4/shell/browser/notifications/mac/cocoa_notification.mm).

Node fixtures qualify the actual IPC admission, bounded retention, native-event
failure mapping, exact-owner clicks and retirement using inert native doubles.
Browser fixtures qualify real settings actions, independent preferences,
late-result rejection and exact-chat navigation through a synthetic bridge.
These checks do not attest a visible macOS banner or the authorization/signing
state of an already running installation. Native signed-app delivery remains
a separate host check; building this source does not restart the running app.
