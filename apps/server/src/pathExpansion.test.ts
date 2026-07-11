// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { expandHomePath } from "./pathExpansion.ts";

describe("expandHomePath", () => {
  it("expands only supported home-relative path forms", () => {
    const cases = [
      ["empty", "", ""],
      ["absolute", "/absolute/path", "/absolute/path"],
      ["relative", "relative/path", "relative/path"],
      ["embedded tilde", "some~weird~path", "some~weird~path"],
      ["home", "~", homedir()],
      ["POSIX home subpath", "~/.codex-work", join(homedir(), ".codex-work")],
      ["Windows home subpath", "~\\.codex", join(homedir(), ".codex")],
      ["named user", "~alice/foo", "~alice/foo"],
    ] as const;

    for (const [name, input, expected] of cases) {
      expect(expandHomePath(input), name).toBe(expected);
    }
  });
});
