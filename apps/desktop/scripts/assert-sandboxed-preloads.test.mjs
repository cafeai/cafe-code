import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { assertSandboxedPreloadSource } from "./assert-sandboxed-preloads.mjs";

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
});
