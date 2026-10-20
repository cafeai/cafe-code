// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const activityMaintenance = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  runMain: vi.fn(),
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor(path: string) {
      activityMaintenance.openDatabase(path);
      throw new Error("Option tests must never open SQLite.");
    }
  },
}));
vi.mock("@effect/platform-node/NodeRuntime", () => ({
  runMain: activityMaintenance.runMain,
}));

import { parseOptions } from "./compact-activity-payloads.ts";

describe("activity payload maintenance target selection", () => {
  it("does not start maintenance or open SQLite when imported", () => {
    expect(activityMaintenance.runMain).not.toHaveBeenCalled();
    expect(activityMaintenance.openDatabase).not.toHaveBeenCalled();
  });

  it.each([[], ["--write"], ["--vacuum"], ["--min-bytes", "0"]].map((args) => ({ args })))(
    "requires an explicit database before resolving paths or opening data: $args",
    ({ args }) => {
      const resolvePath = vi.fn(() => {
        throw new Error("Path resolution must not occur.");
      });
      expect(() => parseOptions(args, resolvePath)).toThrow("An explicit --db <path> is required");
      expect(resolvePath).not.toHaveBeenCalled();
      expect(activityMaintenance.openDatabase).not.toHaveBeenCalled();
    },
  );

  it.each([["--db"], ["--db", ""], ["--db", "   "], ["--db", "--write"]].map((args) => ({ args })))(
    "rejects a missing or flag-shaped database target: $args",
    ({ args }) => {
      const resolvePath = vi.fn(() => "must-not-resolve");
      expect(() => parseOptions(args, resolvePath)).toThrow(
        "--db requires an explicit database path",
      );
      expect(resolvePath).not.toHaveBeenCalled();
      expect(activityMaintenance.openDatabase).not.toHaveBeenCalled();
    },
  );

  it.each(["production", "debug"] as const)(
    "preserves an explicit %s target without redirecting it",
    (profile) => {
      const root = resolve("fixture Cafe home");
      const dbPath = join(
        root,
        ...(profile === "debug" ? [".debug"] : []),
        "userdata",
        "state.sqlite",
      );
      expect(parseOptions(["--db", dbPath])).toEqual({
        dbPath,
        write: false,
        vacuum: false,
        minBytes: 2048,
      });
      expect(parseOptions(["--db", dbPath, "--write", "--vacuum", "--min-bytes", "4096"])).toEqual({
        dbPath,
        write: true,
        vacuum: true,
        minBytes: 4096,
      });
      expect(activityMaintenance.openDatabase).not.toHaveBeenCalled();
    },
  );
});
