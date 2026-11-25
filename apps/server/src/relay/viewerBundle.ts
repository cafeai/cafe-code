import { createHash } from "node:crypto";
// Electron's packaged static directory is a native archive path boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { basename, join, resolve } from "node:path";
import { gzip } from "node:zlib";
import { Budget } from "@cafecode/relay/budget";
import { readApplicationOutputFile } from "@cafecode/shared/applicationBuildVersion";
import {
  RELAY_VIEWER_MANIFEST,
  RELAY_VIEWER_MAX_ASSET,
  RELAY_VIEWER_MAX_MANIFEST,
  RELAY_VIEWER_PATH,
  readRelayViewerManifest,
} from "@cafecode/relay/viewerBundle";

declare const __CAFE_RELAY_VIEWER_MANIFEST_DIGEST__: string | undefined;
export const RELAY_VIEWER_BUILD_DIGEST =
  typeof __CAFE_RELAY_VIEWER_MANIFEST_DIGEST__ === "string"
    ? __CAFE_RELAY_VIEWER_MANIFEST_DIGEST__
    : undefined;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function openRelayViewerBundle(
  staticDir: string | undefined,
  buildDigest: string | undefined,
) {
  if (!staticDir || !buildDigest) return undefined;
  // ASAR virtual paths synthesize stat metadata. The installer puts this exact
  // directory on disk beside the archive for the same native file checks.
  const archive = resolve(staticDir, "../../../..");
  const client = ["apps", "server", "dist", "client"];
  const root =
    process.versions.electron &&
    basename(archive) === "app.asar" &&
    join(archive, ...client) === staticDir
      ? join(archive + ".unpacked", ...client)
      : staticDir;
  try {
    const manifest = readApplicationOutputFile(
      root,
      RELAY_VIEWER_MANIFEST,
      RELAY_VIEWER_MAX_MANIFEST,
    );
    if (digest(manifest) !== buildDigest) return undefined;
    const { files } = readRelayViewerManifest(manifest);
    const memory = new Budget(64 * 1024 * 1024);
    return async (
      path: string,
      signal: AbortSignal,
      hold: (release: () => void) => void,
    ): Promise<Response> => {
      if (path === RELAY_VIEWER_PATH + "/manifest")
        return new Response(manifest, { headers: { "content-type": "application/json" } });
      const prefix = RELAY_VIEWER_PATH + "/asset/" + buildDigest + "/";
      const file = path.startsWith(prefix) ? files.get(path.slice(prefix.length)) : undefined;
      if (!file) return new Response(null, { status: 404 });
      const release = memory.reserve(file.bytes * 3 + 65_536);
      if (!release) return new Response(null, { status: 503 });
      hold(release);
      try {
        signal.throwIfAborted();
        const bytes = readApplicationOutputFile(
          root,
          file.file,
          RELAY_VIEWER_MAX_ASSET,
          file.bytes,
        );
        if (digest(bytes) !== file.sha256) return new Response(null, { status: 409 });
        // This is an application gzip representation inside Noise. Browsers
        // verify its bounded decoded bytes against the same pinned manifest.
        const compressed = await new Promise<Buffer<ArrayBuffer>>((resolve, reject) =>
          gzip(bytes, (error, result) => (error ? reject(error) : resolve(result))),
        );
        signal.throwIfAborted();
        return new Response(compressed, { headers: { "content-type": "application/gzip" } });
      } catch {
        return new Response(null, { status: 409 });
      }
    };
  } catch {
    return undefined;
  }
}
