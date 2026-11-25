import { createHash } from "node:crypto";
// The fixture owns a temporary build directory and its complete cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { RELAY_VIEWER_MANIFEST, RELAY_VIEWER_PATH } from "@cafecode/relay/viewerBundle";
import { openRelayViewerBundle } from "./viewerBundle.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const entry = "assets/app.js";

async function writeBuild(root: string, app: string) {
  const bytes = new TextEncoder();
  const index = bytes.encode('<script type="module" src="/assets/app.js"></script>');
  const payload = bytes.encode(app);
  const manifest = canonicalBytes({
    version: 1,
    applicationVersion: "1.0.0",
    files: (
      [
        [entry, payload],
        ["index.html", index],
      ] as const
    ).map(([file, data]) => ({
      file,
      bytes: data.byteLength,
      sha256: digest(data),
    })),
  });
  await writeFile(join(root, "index.html"), index);
  await writeFile(join(root, entry), payload);
  await writeFile(join(root, RELAY_VIEWER_MANIFEST), manifest);
  return digest(manifest);
}

it("pins exact host build bytes even when a different build has the same application version", async () => {
  const root = await mkdtemp(join(tmpdir(), "cafe-relay-viewer-"));
  try {
    await mkdir(join(root, "assets"));
    const original = await writeBuild(root, "export const build = 'one'");
    const signal = new AbortController().signal;
    const viewer = openRelayViewerBundle(root, original);
    expect(viewer).toBeDefined();
    const read = async (path: string) => {
      let release: (() => void) | undefined;
      try {
        const response = await viewer!(RELAY_VIEWER_PATH + path, signal, (fn) => {
          release = fn;
        });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      } finally {
        release?.();
      }
    };
    const assetPath = "/asset/" + original + "/" + entry;
    const shipped = await read(assetPath);
    expect(shipped.status).toBe(200);
    expect(gunzipSync(shipped.body).toString()).toBe("export const build = 'one'");
    const changed = await writeBuild(root, "export const build = 'two'");
    expect(changed).not.toBe(original);
    expect(openRelayViewerBundle(root, original)).toBeUndefined();
    expect((await read(assetPath)).status).toBe(409);
    expect((await read("/asset/" + changed + "/" + entry)).status).toBe(404);
    expect((await read("/asset/" + original + "/../private")).status).toBe(404);
    expect(digest((await read("/manifest")).body)).toBe(original);
    if (process.platform !== "win32") {
      await rm(join(root, entry));
      await writeFile(join(root, "alternative.js"), "export const build = 'one'");
      await symlink(join(root, "alternative.js"), join(root, entry));
      expect((await read(assetPath)).status).toBe(409);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
