import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUA_DRIVER_RELEASE,
  fetchPinnedCuaArtifact,
  reviewCuaRelease,
  validateCuaRelease,
  type CuaRelease,
} from "./cua-driver-release.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "cafe-cua-release-"));
  roots.push(root);
  const bytes = Buffer.from("isolated synthetic artifact, never executed");
  const release: CuaRelease = {
    ...CUA_DRIVER_RELEASE,
    assets: {
      ...CUA_DRIVER_RELEASE.assets,
      "darwin-universal": {
        ...CUA_DRIVER_RELEASE.assets["darwin-universal"],
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
  const request = vi.fn<typeof fetch>(async () => new Response(bytes));
  return { root, bytes, release, request };
}

describe("pinned Cua artifact fetch", () => {
  it("writes only bytes matching the exact pin and preserves existing files", async () => {
    const f = await fixture();
    const path = await fetchPinnedCuaArtifact({
      ...f,
      target: "darwin-universal",
      outputDirectory: f.root,
    });
    expect(await fs.readFile(path)).toEqual(f.bytes);
    expect(f.request.mock.calls[0]?.[0]).toBe(
      `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_RELEASE.tag}/${CUA_DRIVER_RELEASE.assets["darwin-universal"].name}`,
    );
    await fs.writeFile(path, "existing local evidence");
    await expect(
      fetchPinnedCuaArtifact({ ...f, target: "darwin-universal", outputDirectory: f.root }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(path, "utf8")).toBe("existing local evidence");
  });

  it.each(["corrupt", "oversized", "truncated", "http-error"])(
    "rejects %s downloads before publishing any file",
    async (fault) => {
      const f = await fixture();
      f.request.mockImplementation(async () => {
        if (fault === "http-error") return new Response("unavailable", { status: 503 });
        return new Response(
          fault === "oversized"
            ? Buffer.concat([f.bytes, Buffer.from("extra")])
            : fault === "truncated"
              ? f.bytes.subarray(0, 10)
              : Buffer.alloc(f.bytes.length, 0),
        );
      });
      await expect(
        fetchPinnedCuaArtifact({ ...f, target: "darwin-universal", outputDirectory: f.root }),
      ).rejects.toThrow();
      expect(await fs.readdir(f.root)).toEqual([]);
    },
  );

  it("rejects source substitution, unpinned archives and path traversal before networking", async () => {
    const f = await fixture();
    for (const release of [
      { ...f.release, repository: "untrusted/cua" },
      { ...f.release, version: "latest" },
      { ...f.release, sourceCommit: "main" },
      { ...f.release, auditedAt: null, checksumManifest: null, reviewRequired: true },
      { ...f.release, certificateIdentity: "https://github.com/untrusted/workflow" },
      {
        ...f.release,
        assets: {
          ...f.release.assets,
          "darwin-universal": { ...f.release.assets["darwin-universal"], name: "../../executable" },
        },
      },
    ]) {
      await expect(
        fetchPinnedCuaArtifact({
          ...f,
          release,
          target: "darwin-universal",
          outputDirectory: f.root,
        }),
      ).rejects.toThrow();
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });
});

describe("Cua upgrade review", () => {
  it("creates an explicitly unaudited candidate and never changes the trusted release", async () => {
    const before = structuredClone(CUA_DRIVER_RELEASE);
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/git/ref/"))
        return Response.json({ object: { type: "commit", sha: CUA_DRIVER_RELEASE.sourceCommit } });
      return Response.json({
        tag_name: CUA_DRIVER_RELEASE.tag,
        draft: false,
        prerelease: true,
        assets: Object.values(CUA_DRIVER_RELEASE.assets).map((asset) => ({
          name: asset.name,
          size: asset.bytes,
          digest: `sha256:${asset.sha256}`,
        })),
      });
    });
    const candidate = await reviewCuaRelease(CUA_DRIVER_RELEASE.version, request);
    expect(candidate).toMatchObject({
      version: CUA_DRIVER_RELEASE.version,
      sourceCommit: CUA_DRIVER_RELEASE.sourceCommit,
      reviewRequired: true,
      auditedAt: null,
      checksumManifest: null,
      audit: { status: "candidate", integrationApproved: false },
    });
    expect(CUA_DRIVER_RELEASE).toEqual(before);
    // Upstream uses GitHub's prerelease label for monorepo product routing.
    // The review still requires an exact SemVer, never a floating channel.
    for (const version of ["latest", "0.34.0-rc.1", "0.34.0/../../main", "00.34.0"]) {
      await expect(reviewCuaRelease(version, request)).rejects.toThrow();
    }
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched upstream release instead of producing a candidate", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ tag_name: "cua-driver-rs-v9.9.9", draft: false, assets: [] }),
    );
    await expect(reviewCuaRelease(CUA_DRIVER_RELEASE.version, request)).rejects.toThrow("identity");
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => validateCuaRelease(CUA_DRIVER_RELEASE)).not.toThrow();
  });
});
