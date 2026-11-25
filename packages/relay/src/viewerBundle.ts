import * as Schema from "effect/Schema";
import { requireRelay } from "./errors.ts";
import { readCanonical, SafeCounter } from "./protocol.ts";

export const RELAY_VIEWER_MANIFEST = "relay-viewer-v1.json";
export const RELAY_VIEWER_PATH = "/api/relay/viewer/v1";
export const RELAY_VIEWER_PROBE_PATH = "/.well-known/cafe-code/environment";
export const RELAY_VIEWER_PROBE_ACCEPT = "application/vnd.cafecode.relay-viewer.v1+json";
export const RELAY_VIEWER_MAX_MANIFEST = 256 * 1024;
export const RELAY_VIEWER_MAX_ASSET = 12 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

const assetTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".webmanifest", "application/manifest+json"],
]);

export function relayViewerAssetType(file: string): string | undefined {
  if (file === "index.html") return "text/html; charset=utf-8";
  if (
    file.length > 256 ||
    !file.split("/").every((part) => /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(part)) ||
    !/^(?:assets\/|app-branding\/neutral-v1\/|icon[^/]*\.|manifest(?:\.[a-z]+)?\.webmanifest$)/.test(
      file,
    )
  )
    return undefined;
  const extension = file.slice(file.lastIndexOf("."));
  if (!file.startsWith("assets/") && [".js", ".mjs", ".wasm", ".css"].includes(extension))
    return undefined;
  return assetTypes.get(extension);
}

const Entry = Schema.Struct({
  file: Schema.String.check(Schema.isMaxLength(256)),
  bytes: SafeCounter,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  applicationVersion: Schema.String.check(Schema.isMaxLength(128)),
  files: Schema.Array(Entry).check(Schema.isMinLength(2), Schema.isMaxLength(1024)),
});
export type RelayViewerAsset = typeof Entry.Type;

export function readRelayViewerManifest(bytes: Uint8Array) {
  const manifest = readCanonical(Manifest, bytes, RELAY_VIEWER_MAX_MANIFEST);
  const files = new Map<string, RelayViewerAsset>();
  let size = 0;
  for (const asset of manifest.files) {
    requireRelay(
      relayViewerAssetType(asset.file) &&
        asset.bytes <= RELAY_VIEWER_MAX_ASSET &&
        !files.has(asset.file),
    );
    size += asset.bytes;
    requireRelay(size <= MAX_BUNDLE_BYTES);
    files.set(asset.file, asset);
  }
  requireRelay(files.has("index.html") && [...files.keys()].some((file) => /\.m?js$/.test(file)));
  return { applicationVersion: manifest.applicationVersion, files };
}
