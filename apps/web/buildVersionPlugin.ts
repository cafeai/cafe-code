// Vite invokes this synchronous native write boundary outside an Effect
// runtime; preserve its exact host path semantics for the byte-bound receipt.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
// These writes belong to Vite's native build-output boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { canonicalBytes } from "@cafecode/relay/protocol";
import {
  RELAY_VIEWER_MANIFEST,
  RELAY_VIEWER_MAX_ASSET,
  RELAY_VIEWER_MAX_MANIFEST,
  readRelayViewerManifest,
  relayViewerAssetType,
} from "@cafecode/relay/viewerBundle";
import {
  publishApplicationBuildVersionManifest,
  readApplicationOutputFile,
} from "../../packages/shared/src/applicationBuildVersion.ts";

function writeRelayViewerManifest(
  root: string,
  applicationVersion: string,
  emitted: readonly string[],
) {
  const publicFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const branding = "app-branding/neutral-v1";
  if (existsSync(resolve(root, branding)))
    for (const name of readdirSync(resolve(root, branding)))
      publicFiles.push(branding + "/" + name);
  const files = [...new Set([...emitted, ...publicFiles])].toSorted().flatMap((file) => {
    if (!relayViewerAssetType(file)) return [];
    const bytes = readApplicationOutputFile(root, file, RELAY_VIEWER_MAX_ASSET);
    return [
      { file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    ];
  });
  const manifest = canonicalBytes(
    { version: 1, applicationVersion, files },
    RELAY_VIEWER_MAX_MANIFEST,
  );
  readRelayViewerManifest(manifest);
  writeFileSync(resolve(root, RELAY_VIEWER_MANIFEST), manifest, { flag: "wx" });
}

/** Record the version-bearing renderer bytes only after Vite writes them.
 *
 * A release version supplied after the web build cannot repair an older baked
 * APP_VERSION. The artifact builder therefore requires this separate receipt,
 * including the actual HTML/JavaScript hashes, before it may reuse or copy a
 * renderer. CSS, icons and source maps cannot change the application identity
 * and remain covered by the final release archive's existing integrity gates.
 */
export function createApplicationBuildVersionPlugin(applicationVersion: string): Plugin {
  return {
    name: "cafe-application-build-version",
    apply: "build",
    writeBundle(options, bundle) {
      if (!options.dir) throw new Error("Application version receipt requires a build directory.");
      const files: Record<string, string | Uint8Array> = {};
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") files[output.fileName] = output.code;
        else if (output.fileName === "index.html") files[output.fileName] = output.source;
      }
      publishApplicationBuildVersionManifest(
        resolve(options.dir),
        "web",
        applicationVersion,
        files,
      );
      writeRelayViewerManifest(resolve(options.dir), applicationVersion, Object.keys(bundle));
    },
  };
}
