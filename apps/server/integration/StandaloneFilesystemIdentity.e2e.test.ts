// @effect-diagnostics nodeBuiltinImport:off
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  isStandaloneStableDevice,
  readStandaloneDeviceIdentity,
} from "../src/orchestration/standaloneFilesystemIdentity.ts";

/**
 * Explicit native macOS metadata qualification. The fixture owns one temporary
 * directory, invokes only the production bounded disk-metadata helpers, and
 * never reads a user/provider profile or launches paid inference. Non-macOS
 * device policy is covered by the synthetic default tests on every host.
 * Run with the repository's vitest.e2e.config.ts and this exact file selected.
 */
it.skipIf(process.platform !== "darwin")(
  "binds a real scoped macOS directory to a stable native volume identity",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cafe-volume-identity-")));
    try {
      const before = await lstat(directory, { bigint: true });
      const identity = await readStandaloneDeviceIdentity(directory, before.dev);
      expect(isStandaloneStableDevice(identity)).toBe(true);
      expect(await readStandaloneDeviceIdentity(directory, before.dev)).toBe(identity);
      const after = await lstat(directory, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      await expect(readStandaloneDeviceIdentity(directory, before.dev + 1n)).rejects.toThrow(
        "Standalone chat filesystem identity is unavailable.",
      );
    } finally {
      // Cleanup is scoped to the exact filesystem-minted temporary directory.
      await rm(directory, { recursive: true });
    }
  },
  25_000,
);
