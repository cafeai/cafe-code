// Vite invokes this synchronous native write boundary outside an Effect
// runtime; preserve its exact host path semantics for the byte-bound receipt.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { publishApplicationBuildVersionManifest } from "../../packages/shared/src/applicationBuildVersion.ts";

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
    },
  };
}
