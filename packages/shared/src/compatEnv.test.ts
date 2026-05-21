import { describe, expect, it } from "vitest";

import { cafeCodeEnvName, readCafeCodeEnv, writeCafeCodeEnv } from "./compatEnv.ts";

describe("compatEnv", () => {
  it("accepts Cafe Code env names", () => {
    expect(cafeCodeEnvName("CAFE_CODE_HOME")).toBe("CAFE_CODE_HOME");
  });

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
});
