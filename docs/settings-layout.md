# Settings layout

Preferences are grouped by the behavior they control:

| Page                        | Controls                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| General                     | Language, time format, default project folder, new-chat workspace, file editor, desktop keep-awake, About                 |
| Appearance                  | Theme/size/accent, sidebar branding and image, animations, weather effects, Atrium color                                  |
| Chats                       | Navigation and Task Atrium availability, Assistant output, plan panel, selection copy, custom instructions, confirmations |
| Providers                   | Automatic naming model plus existing account/runtime management                                                           |
| Cafe tools                  | Owner-authorized management MCP access for Cafe-launched agents                                                           |
| Connections & remote access | Saved environments, listener/TLS, pairing and devices                                                                     |
| History                     | Archive and Recently deleted, retaining their existing scoped actions                                                     |

Notifications, Keybindings, Dictation, Source control, Usage and Diagnostics retain their dedicated pages. Legacy Ambiance, Files and System URLs redirect to the current owning page. Archive and Recently deleted retain their URLs and share History navigation.

`Reset this page` enumerates only changed, defaultable controls on the current page. It does not reset provider accounts, credentials, connection configuration, instructions or history. Language stays a local client preference even when a remote workspace is selected. Keep-awake controls and reset entries require the native desktop capability.

The sidebar image is off for a missing/new preference, including setup. An explicit saved value survives. Its picker sits directly below Enable sidebar image; disabled controls stay visible and dimmed, without discarding the saved image. Setup uses the same preference and opt-in switch.

Source-owned labels remain translated in English, Japanese and Korean. The existing Settings browser suite covers the shared layout and capability gates on macOS/Windows and Linux; synthetic browser/platform evidence does not qualify native OS behavior or live provider capacity.
