// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import {
  composeSystemPromptProviderInput,
  ensureSystemPromptFile,
  readSystemPromptFileForInjection,
} from "./systemPromptFile.ts";

describe("systemPromptFile", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  function makePromptPath() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-system-prompt-"));
    tempDirs.add(tempDir);
    return path.join(tempDir, "userdata", "system-prompt.md");
  }

  it("creates an empty prompt file without exposing default prompt content", async () => {
    const promptPath = makePromptPath();

    await Effect.runPromise(
      ensureSystemPromptFile(promptPath).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.readFileSync(promptPath, "utf8")).toBe("");
  });

  it("reads non-empty trimmed prompt content and treats missing or blank files as disabled", async () => {
    const promptPath = makePromptPath();

    await expect(
      Effect.runPromise(
        readSystemPromptFileForInjection(promptPath).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).resolves.toBeUndefined();

    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "  Follow repo instructions.  \n", "utf8");
    await expect(
      Effect.runPromise(
        readSystemPromptFileForInjection(promptPath).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).resolves.toBe("Follow repo instructions.");

    fs.writeFileSync(promptPath, "\n\t  \n", "utf8");
    await expect(
      Effect.runPromise(
        readSystemPromptFileForInjection(promptPath).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).resolves.toBeUndefined();
  });

  it("composes provider input with a clear delimiter", () => {
    expect(
      composeSystemPromptProviderInput({
        systemPrompt: "  Be precise.  ",
        userMessage: "  Implement the feature.  ",
      }),
    ).toBe("System prompt:\nBe precise.\n\nUser request:\nImplement the feature.");
  });
});
