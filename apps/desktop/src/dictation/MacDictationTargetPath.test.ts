// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMacDictationTargetPath } from "./MacDictationTargetPath.ts";

const sourceEnvironment = {
  platform: "darwin" as const,
  processArch: "arm64",
  isPackaged: false,
  appRoot: "/repo",
  resourcesPath: "/Applications/Cafe Code.app/Contents/Resources",
};

describe("resolveMacDictationTargetPath", () => {
  it("selects the source helper for the current desktop architecture", () => {
    expect(resolveMacDictationTargetPath(sourceEnvironment)).toBe(
      join("/repo", "apps/desktop/native/build/arm64/mac-dictation-target"),
    );
    expect(resolveMacDictationTargetPath({ ...sourceEnvironment, processArch: "x64" })).toBe(
      join("/repo", "apps/desktop/native/build/x64/mac-dictation-target"),
    );
  });

  it("selects the separate signed app resource in a packaged build", () => {
    expect(resolveMacDictationTargetPath({ ...sourceEnvironment, isPackaged: true })).toBe(
      join(sourceEnvironment.resourcesPath, "mac-dictation-target"),
    );
  });

  it("does not expose the macOS helper on other platforms", () => {
    expect(resolveMacDictationTargetPath({ ...sourceEnvironment, platform: "win32" })).toBeNull();
    expect(resolveMacDictationTargetPath({ ...sourceEnvironment, platform: "linux" })).toBeNull();
  });
});
