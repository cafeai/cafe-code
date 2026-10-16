import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseMacosArtifactKeychainPartition,
  withIsolatedMacosArtifactKeychain,
} from "./macos-artifact-keychain.ts";

const executableHash = "a".repeat(40);
const adHocIdentity = `CDHash=${executableHash}\nSignature=adhoc\nTeamIdentifier=not set\n`;
const signedIdentity = `CDHash=${executableHash}\nAuthority=Developer ID Application: Fixture (AB12345678)\nTeamIdentifier=AB12345678\n`;

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
            join(root, "Cafe Code"),
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

  it("uses native ad-hoc and Developer ID partitions and rejects ambiguous identity", () => {
    expect(
      parseMacosArtifactKeychainPartition(
        `Identifier=Cafe Code\nCandidateCDHash sha256=${"b".repeat(40)}\n${adHocIdentity}`,
      ),
    ).toBe(`cdhash:${executableHash}`);
    expect(parseMacosArtifactKeychainPartition(signedIdentity)).toBe("teamid:AB12345678");
    for (const output of [
      "",
      `CandidateCDHash sha256=${executableHash}`,
      `CDHash=${"a".repeat(39)}`,
      `CDHash=${executableHash}\nCDHash=${executableHash}`,
      `CDHash=${executableHash}\nCDHash=unknown`,
      `CDHash=${executableHash},apple:`,
      `${adHocIdentity}CDHash=${executableHash}`,
      `${adHocIdentity}TeamIdentifier=AB12345678`,
      signedIdentity.replace("AB12345678\n", "AB12345678,apple:\n"),
      signedIdentity.replace("Authority=Developer ID Application:", "Authority=Unknown:"),
      adHocIdentity.replace("Signature=adhoc\n", ""),
    ]) {
      expect(() => parseMacosArtifactKeychainPartition(output)).toThrow();
    }
  });

  it.each([
    { identity: adHocIdentity, partition: `cdhash:${executableHash}`, fail: false },
    { identity: signedIdentity, partition: "teamid:AB12345678", fail: false },
    { identity: adHocIdentity, partition: `cdhash:${executableHash}`, fail: true },
  ])(
    "binds every command to the launched home for $partition and cleans up after failure=$fail",
    async ({ identity, partition, fail }) => {
      const root = await mkdtemp(join(tmpdir(), "cafe-keychain-policy-"));
      const home = join(root, "home");
      await mkdir(home);
      const environment = { HOME: home, CFFIXED_USER_HOME: home };
      const keychain = join(home, "Library", "Keychains", "runtime-smoke.keychain-db");
      const calls: string[][] = [];
      let actions = 0;
      let identities = 0;
      const applicationPath = join(root, "Cafe Code.app", "Contents", "MacOS", "Cafe Code");
      try {
        const run = withIsolatedMacosArtifactKeychain(
          root,
          environment,
          ["Cafe Code", "Chromium", "Cafe Code"],
          applicationPath,
          async () => {
            actions++;
            expect(calls.filter((args) => args[0] === "add-generic-password")).toHaveLength(2);
            expect(
              calls.filter((args) => args[0] === "set-generic-password-partition-list"),
            ).toHaveLength(2);
            if (fail) throw new Error("synthetic action failure");
          },
          async (args, suppliedEnvironment) => {
            expect(suppliedEnvironment).toBe(environment);
            calls.push([...args]);
            return "";
          },
          async (path, suppliedEnvironment) => {
            expect(path).toBe(applicationPath);
            expect(suppliedEnvironment).toBe(environment);
            expect(calls).toEqual([]);
            identities++;
            return identity;
          },
        );
        if (fail) await expect(run).rejects.toThrow("synthetic action failure");
        else await run;
        expect(actions).toBe(1);
        expect(identities).toBe(1);
        expect(calls.map((args) => args[0])).toEqual([
          "create-keychain",
          "set-keychain-settings",
          "unlock-keychain",
          "list-keychains",
          "default-keychain",
          "add-generic-password",
          "set-generic-password-partition-list",
          "add-generic-password",
          "set-generic-password-partition-list",
          "delete-keychain",
        ]);
        expect(calls[0]![2]).toMatch(/^[a-f0-9]{64}$/u);
        expect(calls[3]).toEqual(["list-keychains", "-d", "user", "-s", keychain]);
        expect(calls[4]).toEqual(["default-keychain", "-d", "user", "-s", keychain]);
        for (const [index, name] of ["Cafe Code", "Chromium"].entries()) {
          expect(calls[index * 2 + 5]).toEqual([
            "add-generic-password",
            "-T",
            applicationPath,
            "-a",
            name,
            "-s",
            `${name} Safe Storage`,
            "-w",
            expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/u),
            keychain,
          ]);
          expect(calls[index * 2 + 6]).toEqual([
            "set-generic-password-partition-list",
            "-S",
            `apple-tool:,${partition}`,
            "-a",
            name,
            "-s",
            `${name} Safe Storage`,
            "-k",
            calls[0]![2],
            keychain,
          ]);
        }
        expect(calls.at(-1)).toEqual(["delete-keychain", keychain]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing-identity", "partition-failure"])(
    "refuses %s without launching the app and cleans up an owned keychain",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "cafe-keychain-refusal-"));
      const home = join(root, "home");
      await mkdir(home);
      const commands: string[] = [];
      let actions = 0;
      try {
        await expect(
          withIsolatedMacosArtifactKeychain(
            root,
            { HOME: home, CFFIXED_USER_HOME: home },
            ["Cafe Code"],
            join(root, "Cafe Code"),
            async () => {
              actions++;
            },
            async (args) => {
              commands.push(args[0]!);
              if (args[0] === "set-generic-password-partition-list") {
                throw new Error("synthetic partition failure");
              }
              return "";
            },
            async () => (failure === "missing-identity" ? "" : adHocIdentity),
          ),
        ).rejects.toThrow();
        expect(actions).toBe(0);
        if (failure === "missing-identity") expect(commands).toEqual([]);
        else {
          expect(commands).toContain("create-keychain");
          expect(commands.at(-1)).toBe("delete-keychain");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
