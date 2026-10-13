import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "vitest";

import {
  assertSandboxedPreloadBundles,
  assertSandboxedPreloadSource,
} from "./assert-sandboxed-preloads.mjs";

/** Exercise the production directory reader against exact synthetic emitted
 * files, not a source-only mock or the user's build outputs. The exclusively
 * minted temporary directory is the only namespace this fixture may remove. */
function withEmittedPreloads(check) {
  const desktopDirectory = mkdtempSync(join(tmpdir(), "cafe-sandboxed-preloads-"));
  const emittedDirectory = join(desktopDirectory, "dist-electron");
  try {
    mkdirSync(emittedDirectory, { mode: 0o700 });
    for (const filename of ["preload.cjs", "globalDictationPreload.cjs"])
      writeFileSync(
        join(emittedDirectory, filename),
        'const { contextBridge } = require("electron");',
        { flag: "wx", mode: 0o600 },
      );
    return check({ desktopDirectory, emittedDirectory });
  } finally {
    rmSync(desktopDirectory, { recursive: true, force: true });
  }
}

describe("sandboxed desktop preload bundle", () => {
  it("accepts Electron's supported sandbox preload modules", () => {
    assert.doesNotThrow(() =>
      assertSandboxedPreloadSource('const { contextBridge } = require("electron");', "preload.cjs"),
    );
  });

  it("rejects a shared relative chunk emitted by a multi-entry build", () => {
    assert.throws(
      () =>
        assertSandboxedPreloadSource(
          'const channels = require("./channels-BLatOA1z.cjs");',
          "preload.cjs",
        ),
      /unavailable to Electron's sandboxed preload/u,
    );
  });

  it.each(["crypto", "node:crypto"])(
    "rejects an emitted Node cryptographic import %s without expanding sandbox authority",
    (specifier) => {
      assert.throws(
        () =>
          assertSandboxedPreloadSource(
            `const { randomUUID } = require("${specifier}");`,
            "preload.cjs",
          ),
        /unavailable to Electron's sandboxed preload/u,
      );
      assert.doesNotThrow(() =>
        assertSandboxedPreloadSource(
          "const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));",
          "preload.cjs",
        ),
      );
    },
  );

  it("rejects dynamic or non-literal imports that cannot run in the sandbox", () => {
    assert.throws(
      () => assertSandboxedPreloadSource("const channels = require(path);", "preload.cjs"),
      /unavailable to Electron's sandboxed preload/u,
    );
    assert.throws(
      () => assertSandboxedPreloadSource('void import("./channels.cjs");', "preload.cjs"),
      /dynamic import unavailable/u,
    );
  });

  it("admits both real emitted production bundles without requiring a retired visualization preload", () => {
    withEmittedPreloads(({ desktopDirectory, emittedDirectory }) => {
      assert.equal(existsSync(join(emittedDirectory, "visualizationPreload.cjs")), false);
      assert.doesNotThrow(() => assertSandboxedPreloadBundles(desktopDirectory));
    });
  });

  it.each(["preload.cjs", "globalDictationPreload.cjs"])(
    "rejects an unsafe import from the actual emitted %s file",
    (filename) => {
      withEmittedPreloads(({ desktopDirectory, emittedDirectory }) => {
        writeFileSync(
          join(emittedDirectory, filename),
          'const shared = require("./shared-preload-chunk.cjs");',
        );
        assert.throws(
          () => assertSandboxedPreloadBundles(desktopDirectory),
          (error) =>
            error instanceof Error &&
            error.message ===
              `${filename} imports a module unavailable to Electron's sandboxed preload.`,
        );
      });
    },
  );

  it.each(["preload.cjs", "globalDictationPreload.cjs"])(
    "refuses a missing required emitted %s file instead of skipping its checks",
    (filename) => {
      withEmittedPreloads(({ desktopDirectory, emittedDirectory }) => {
        const missingPath = join(emittedDirectory, filename);
        unlinkSync(missingPath);
        assert.throws(
          () => assertSandboxedPreloadBundles(desktopDirectory),
          (error) =>
            error instanceof Error && error.code === "ENOENT" && error.path === missingPath,
        );
      });
    },
  );
});
