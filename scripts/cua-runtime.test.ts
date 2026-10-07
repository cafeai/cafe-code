import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stageNativeCuaRuntime } from "./lib/cua-runtime.ts";
import { verifyNativeRuntime } from "@cafecode/shared/nativeRuntime";
import release from "../native/cua-driver/release.json" with { type: "json" };
import policy from "../native/cua-driver/build.json" with { type: "json" };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "cafe-cua-stage-"));
  roots.push(root);
  const runtime = join(root, "native/cua-driver/runtime/darwin-arm64");
  const resources = join(root, "resources");
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(resources);
  const bytes = Buffer.from("isolated synthetic native payload; never executed");
  const manifest = {
    schemaVersion: 1,
    version: release.version,
    sourceCommit: release.sourceCommit,
    patchSha256: policy.patchSha256,
    platform: "darwin",
    arch: "arm64",
    binary: "cua-driver",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrationApproved: true,
  };
  await fs.writeFile(join(runtime, "cua-driver"), bytes, { mode: 0o755 });
  await fs.writeFile(join(runtime, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  for (const name of ["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "local-only.patch"])
    await fs.writeFile(join(root, "native/cua-driver", name), `fixture ${name}`);
  return { root, runtime, resources, manifest, bytes };
}

it("stages only the matching verified Mac executable and preserves notices outside ordinary app resources", async () => {
  const f = await fixture();
  expect(await stageNativeCuaRuntime(f.root, f.resources, "mac", "arm64")).toBe(true);
  const destination = join(f.resources, "cua-driver");
  expect(await verifyNativeRuntime(destination, { platform: "darwin", arch: "arm64" })).toBe(
    join(destination, "cua-driver"),
  );
  expect(await fs.readFile(join(destination, "cua-driver"))).toEqual(f.bytes);
  if (process.platform !== "win32") {
    expect((await fs.stat(join(destination, "manifest.json"))).mode & 0o777).toBe(0o644);
    expect((await fs.stat(join(destination, "cua-driver"))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(join(f.runtime, "manifest.json"))).mode & 0o777).toBe(0o600);
  }
  expect(await fs.readFile(join(destination, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe(
    "fixture THIRD_PARTY_NOTICES.md",
  );
});
it("leaves unsupported platforms, universal targets and absent runtimes unstaged", async () => {
  const f = await fixture();
  for (const [platform, arch] of [
    ["win", "arm64"],
    ["linux", "arm64"],
    ["mac", "universal"],
    ["mac", "x64"],
  ])
    expect(await stageNativeCuaRuntime(f.root, f.resources, platform!, arch!)).toBe(false);
  expect(await fs.readdir(f.resources)).toEqual([]);
  await expect(
    verifyNativeRuntime(f.runtime, { platform: "win32", arch: "arm64" }),
  ).rejects.toThrow("only on macOS");
});
it("rejects replaced bytes, foreign architecture and a forged source approval before staging", async () => {
  const f = await fixture();
  await expect(verifyNativeRuntime(f.runtime, { platform: "darwin", arch: "x64" })).rejects.toThrow(
    "source pin",
  );
  for (const patch of [
    { sourceCommit: "f".repeat(40) },
    { patchSha256: "f".repeat(64) },
    { binary: "../untrusted" },
    { integrationApproved: false },
  ]) {
    await fs.writeFile(
      join(f.runtime, "manifest.json"),
      JSON.stringify({ ...f.manifest, ...patch }),
    );
    await expect(stageNativeCuaRuntime(f.root, f.resources, "mac", "arm64")).rejects.toThrow(
      "source pin",
    );
  }
  await fs.writeFile(join(f.runtime, "manifest.json"), JSON.stringify(f.manifest));
  await fs.writeFile(join(f.runtime, "cua-driver"), "replaced bytes");
  await expect(stageNativeCuaRuntime(f.root, f.resources, "mac", "arm64")).rejects.toThrow(
    "integrity",
  );
  expect(await fs.readdir(f.resources)).toEqual([]);
});
