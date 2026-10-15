import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withIsolatedMacosArtifactKeychain } from "./macos-artifact-keychain.ts";

describe("isolated macOS artifact keychain", () => {
  it("refuses an existing keychain before changing native preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-keychain-existing-"));
    let commands = 0;
    try {
      await writeFile(join(root, "runtime-smoke.keychain-db"), "existing fixture");
      await expect(
        withIsolatedMacosArtifactKeychain(
          root,
          async () => {},
          async () => {
            commands++;
            return "";
          },
        ),
      ).rejects.toThrow("already exists");
      expect(commands).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "restores exact original preferences after action failure=%s",
    async (fail) => {
      const root = await mkdtemp(join(tmpdir(), "cafe-keychain-policy-"));
      const original = join(root, "original keychain-db");
      const secondary = join(root, "secondary keychain-db");
      const calls: string[][] = [];
      let actions = 0;
      const security = async (args: readonly string[]) => {
        calls.push([...args]);
        if (args.length === 3 && args[0] === "default-keychain") return JSON.stringify(original);
        if (args.length === 3 && args[0] === "list-keychains") {
          return [original, secondary].map((path) => JSON.stringify(path)).join("\n");
        }
        return "";
      };
      try {
        const run = withIsolatedMacosArtifactKeychain(
          root,
          async () => {
            actions++;
            expect(calls.at(-1)).toEqual([
              "default-keychain",
              "-d",
              "user",
              "-s",
              join(root, "runtime-smoke.keychain-db"),
            ]);
            if (fail) throw new Error("synthetic action failure");
          },
          security,
        );
        if (fail) await expect(run).rejects.toThrow("synthetic action failure");
        else await run;
        expect(actions).toBe(1);
        expect(calls.map((args) => args[0])).toEqual([
          "default-keychain",
          "list-keychains",
          "create-keychain",
          "set-keychain-settings",
          "unlock-keychain",
          "list-keychains",
          "default-keychain",
          "default-keychain",
          "list-keychains",
          "delete-keychain",
        ]);
        const password = calls[2]![2]!;
        expect(password).toMatch(/^[a-f0-9]{64}$/);
        expect(calls[4]).toEqual([
          "unlock-keychain",
          "-p",
          password,
          join(root, "runtime-smoke.keychain-db"),
        ]);
        expect(calls.slice(-3)).toEqual([
          ["default-keychain", "-d", "user", "-s", original],
          ["list-keychains", "-d", "user", "-s", original, secondary],
          ["delete-keychain", join(root, "runtime-smoke.keychain-db")],
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
