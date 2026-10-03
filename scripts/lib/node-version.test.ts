import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseRepositoryNodeVersion, REPOSITORY_NODE_VERSION } from "./node-version.ts";

describe("canonical standalone Node version", () => {
  it("reads one exact stable version with only an optional ordinary file terminator", () => {
    for (const suffix of ["", "\n", "\r\n"]) {
      expect(parseRepositoryNodeVersion(`24.21.0${suffix}`)).toBe("24.21.0");
    }
    expect(
      parseRepositoryNodeVersion(
        readFileSync(new URL("../../.node-version", import.meta.url), "utf8"),
      ),
    ).toBe(REPOSITORY_NODE_VERSION);
  });

  it("rejects aliases, ranges, prereleases, path injection and ambiguous file contents", () => {
    for (const invalid of [
      "",
      "24",
      "24.21",
      "v24.21.0",
      "lts/*",
      "lts/krypton",
      "node",
      "latest",
      "^24.21.0",
      "24.21.0-rc.1",
      "24.21.0+build.1",
      "024.21.0",
      "24.021.0",
      "24.21.00",
      " 24.21.0",
      "24.21.0 ",
      "24.21.0\t",
      "24.21.0\r",
      "24.21.0\n\n",
      "24.21.0\r\n\r\n",
      "24.21.0\n26.10.0",
      "24.21.0/../../file",
      "24.21.0\u2028",
      "24.21.0\0",
      "9007199254740992.0.0",
      `${"9".repeat(65)}.0.0`,
    ]) {
      expect(() => parseRepositoryNodeVersion(invalid), JSON.stringify(invalid)).toThrow(
        ".node-version must contain one exact stable Node.js version.",
      );
    }
  });
});
