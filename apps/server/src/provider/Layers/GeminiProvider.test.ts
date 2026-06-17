// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { GeminiSettings } from "@cafecode/contracts";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkGeminiProviderStatus, GEMINI_ACP_ARGS } from "./GeminiProvider.ts";

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);

describe("GeminiProvider", () => {
  it("uses the stable ACP flag", () => {
    assert.deepEqual(GEMINI_ACP_ARGS, ["--acp"]);
  });

  it.effect("reports an installed Gemini CLI without requiring live auth", () =>
    Effect.gen(function* () {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "cafecode-gemini-provider-"));
      const binaryPath = path.join(tempDir, "gemini");
      writeFileSync(binaryPath, "#!/usr/bin/env bash\necho '0.9.0'\n", { mode: 0o755 });
      chmodSync(binaryPath, 0o755);

      try {
        const snapshot = yield* checkGeminiProviderStatus(
          decodeGeminiSettings({ binaryPath }),
          process.env,
        );

        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.status, "warning");
        assert.equal(snapshot.auth.status, "unknown");
        assert.equal(snapshot.version, "0.9.0");
        assert.equal(snapshot.runtimeCapabilities?.liveSteer, "unsupported");
        assert.ok(snapshot.models.some((model) => model.slug === "gemini-3-pro-preview"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
