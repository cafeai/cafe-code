import { describe, expect, it } from "vitest";

import { readCafeCodeEnv, writeCafeCodeEnv } from "./compatEnv.ts";

describe("compatEnv", () => {
  it("reads Cafe Code env values only", () => {
    expect(
      readCafeCodeEnv(
        {
          CAFE_CODE_HOME: "/tmp/cafe",
        },
        "CAFE_CODE_HOME",
      ),
    ).toBe("/tmp/cafe");
  });

  it("writes Cafe Code env names only", () => {
    const env: Record<string, string | undefined> = {};
    writeCafeCodeEnv(env, "CAFE_CODE_PORT", "3773");

    expect(env).toEqual({
      CAFE_CODE_PORT: "3773",
    });
  });

  it("rejects names outside the Cafe Code namespace", () => {
    expect(() => readCafeCodeEnv({ HOME: "/tmp" }, "HOME")).toThrow(
      "Expected Cafe Code env var to start with CAFE_CODE_",
    );
    expect(() => writeCafeCodeEnv({}, "PORT", "3773")).toThrow(
      "Expected Cafe Code env var to start with CAFE_CODE_",
    );
  });
});
