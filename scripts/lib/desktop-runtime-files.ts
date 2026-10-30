/** Shared omissions for installed and local application dependency trees.
 * Keep executable providers, native PTYs, PDF text assets and
 * license notices; never prune optional dependencies indiscriminately. */
export const DESKTOP_RUNTIME_FILES = [
  "!**/*.map",
  "!**/.source-runtime-dependencies.json",
  // Both Claude query paths provide the selected system/managed executable.
  // Only the SDK's otherwise-unused fallback CLI packages are omitted.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*{,/**/*}",
  // The SDK declares this peer for its type surface; our query/session APIs
  // do not import its runtime. Development still provides the required peer.
  "!**/node_modules/@anthropic-ai/sdk{,/**/*}",
  // PDF attachment extraction uses text content, never Canvas rendering.
  "!**/node_modules/@napi-rs/canvas{,-*}{,/**/*}",
  // These packages export their compiled JavaScript, not the TypeScript tree.
  "!**/node_modules/{effect,@effect/platform-node,@effect/platform-node-shared}/src{,/**/*}",
  // Retain the legacy parser/worker, CMaps, fonts and decoding assets. The
  // browser viewer, modern duplicate and alternate builds are not consumed.
  "!**/node_modules/pdfjs-dist/{build,web,legacy/web,types,image_decoders}{,/**/*}",
  "!**/node_modules/pdfjs-dist/legacy/build/{*.min.mjs,pdf.sandbox.mjs}",
  "!**/node_modules/pdfjs-dist/{CODE_OF_CONDUCT.md,webpack.mjs}",
  // Installer inputs are read from buildResources/extraResources, never the
  // desktop's ordinary runtime resource fallback inside app.asar.
  "!apps/desktop/prod-resources/{installer.nsh,entitlements.mac.plist,managed-runtime{,/**/*}}",
];

// macOS uses en.lproj; Windows/Linux use en-US.pak. Both match the same Cafe
// English UI. Keep the native resources for every supported interface language.
export const DESKTOP_ELECTRON_LANGUAGES = ["en", "en-US", "ja", "ko"];
