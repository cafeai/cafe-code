import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withIsolatedMacosArtifactKeychain } from "./macos-artifact-keychain.ts";

describe("isolated macOS artifact keychain", () => {
  it.each(["foreign-home", "foreign-foundation-home", "existing-preferences"])(
    "refuses %s before any native preference mutation",
    async (invalid) => {
      const root = await mkdtemp(join(tmpdir(), "cafe-keychain-admission-"));
      const home = join(root, "home");
      await mkdir(home);
      let commands = 0;
      try {
        if (invalid === "existing-preferences") await mkdir(join(home, "Library"));
        await expect(
          withIsolatedMacosArtifactKeychain(
            root,
            {
              HOME: invalid === "foreign-home" ? tmpdir() : home,
              CFFIXED_USER_HOME: invalid === "foreign-foundation-home" ? tmpdir() : home,
            },
            [],
            async () => {},
            async () => {
              commands++;
              return "";
            },
          ),
        ).rejects.toThrow();
        expect(commands).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "binds every command to the exact launched home and deletes its keychain after failure=%s",
    async (fail) => {
      const root = await mkdtemp(join(tmpdir(), "cafe-keychain-policy-"));
      const home = join(root, "home");
      await mkdir(home);
      const environment = { HOME: home, CFFIXED_USER_HOME: home };
      const keychain = join(home, "Library", "Keychains", "runtime-smoke.keychain-db");
      const calls: string[][] = [];
      let actions = 0;
      try {
        const run = withIsolatedMacosArtifactKeychain(
          root,
          environment,
          ["Cafe Code", "Chromium", "Cafe Code"],
          async () => {
            actions++;
            expect(calls.filter((args) => args[0] === "add-generic-password")).toHaveLength(2);
            if (fail) throw new Error("synthetic action failure");
          },
          async (args, suppliedEnvironment) => {
            expect(suppliedEnvironment).toBe(environment);
            calls.push([...args]);
            return "";
          },
        );
        if (fail) await expect(run).rejects.toThrow("synthetic action failure");
        else await run;
        expect(actions).toBe(1);
        expect(calls.map((args) => args[0])).toEqual([
          "create-keychain",
          "set-keychain-settings",
          "unlock-keychain",
          "list-keychains",
          "default-keychain",
          "add-generic-password",
          "add-generic-password",
          "delete-keychain",
        ]);
        expect(calls[0]![2]).toMatch(/^[a-f0-9]{64}$/u);
        expect(calls[3]).toEqual(["list-keychains", "-d", "user", "-s", keychain]);
        expect(calls[4]).toEqual(["default-keychain", "-d", "user", "-s", keychain]);
        for (const [index, name] of ["Cafe Code", "Chromium"].entries()) {
          expect(calls[index + 5]).toEqual([
            "add-generic-password",
            "-A",
            "-a",
            name,
            "-s",
            `${name} Safe Storage`,
            "-w",
            expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/u),
            keychain,
          ]);
        }
        expect(calls.at(-1)).toEqual(["delete-keychain", keychain]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
