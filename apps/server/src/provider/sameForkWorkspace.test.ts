import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sameForkWorkspace } from "./sameForkWorkspace.ts";

it("admits normalized and identity-proven directory aliases without substituting a different workspace", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-workspace-"));
  try {
    const actual = path.join(root, "actual");
    const other = path.join(root, "other");
    const alias = path.join(root, "alias");
    mkdirSync(actual);
    mkdirSync(other);
    symlinkSync(actual, alias, "junction");
    expect(await sameForkWorkspace(actual, path.join(actual, "."))).toBe(true);
    expect(await sameForkWorkspace(actual, alias)).toBe(true);
    expect(await sameForkWorkspace(actual, other)).toBe(false);
    expect(await sameForkWorkspace(actual, path.join(root, "absent"))).toBe(false);
    expect(await sameForkWorkspace(actual, undefined)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
