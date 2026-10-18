import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  preferredDataProfileHttpPort,
  resolveBootstrappedDataProfile,
  resolveDataProfileRoot,
} from "./dataProfile.ts";

describe("data profile roots", () => {
  it.each([
    { profile: "production" as const, port: 3773 },
    { profile: "debug" as const, port: 13773 },
    { profile: undefined, port: 3773 },
  ])("keeps the $profile automatic HTTP preference at $port", ({ profile, port }) => {
    expect(preferredDataProfileHttpPort(profile)).toBe(port);
  });
  it.each([path.posix, path.win32])(
    "preserves production and explicitly derives Debug from the configured parent",
    (paths) => {
      const root = paths.resolve("private", "Cafe Code");
      expect(resolveDataProfileRoot(root, "production", paths)).toBe(root);
      expect(resolveDataProfileRoot(root, "debug", paths)).toBe(paths.join(root, ".debug"));
      // A user-selected parent named .debug is still a parent. Never infer
      // resolved-vs-configured authority from its basename.
      const namedParent = paths.join(root, ".debug");
      expect(resolveDataProfileRoot(namedParent, "production", paths)).toBe(namedParent);
      expect(resolveDataProfileRoot(namedParent, "debug", paths)).toBe(
        paths.join(namedParent, ".debug"),
      );
    },
  );
  it.each([path.posix, path.win32])(
    "accepts only a complete exact-child profile pair or wholly legacy home",
    (paths) => {
      const parent = paths.resolve("private", "Cafe Code");
      const effective = paths.join(parent, ".debug");
      expect(
        resolveBootstrappedDataProfile(
          { cafeCodeHome: effective, configuredCafeCodeHome: parent, dataProfile: "debug" },
          paths,
        ),
      ).toEqual({ baseDir: effective, configuredBaseDir: parent, dataProfile: "debug" });
      expect(resolveBootstrappedDataProfile({ cafeCodeHome: parent }, paths)).toEqual({
        baseDir: parent,
        configuredBaseDir: parent,
      });
      for (const invalid of [
        { cafeCodeHome: effective, configuredCafeCodeHome: parent },
        { cafeCodeHome: effective, dataProfile: "debug" as const },
        { cafeCodeHome: parent, configuredCafeCodeHome: parent, dataProfile: "debug" as const },
        {
          cafeCodeHome: effective,
          configuredCafeCodeHome: "relative",
          dataProfile: "debug" as const,
        },
      ])
        expect(() => resolveBootstrappedDataProfile(invalid, paths)).toThrow(
          "incomplete or inconsistent",
        );
    },
  );
});
