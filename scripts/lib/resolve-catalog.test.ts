import { describe, expect, it } from "vitest";

import {
  resolveBundledPackageDependencies,
  resolveCatalogDependencies,
  resolveNpmOverrides,
} from "./resolve-catalog.ts";

describe("resolveCatalogDependencies", () => {
  it("resolves default and named catalog entries", () => {
    expect(
      resolveCatalogDependencies(
        { effect: "catalog:", aliased: "catalog:effect" },
        { effect: "4.0.0-beta.59" },
        "fixture",
      ),
    ).toEqual({ effect: "4.0.0-beta.59", aliased: "4.0.0-beta.59" });
  });
});

describe("resolveBundledPackageDependencies", () => {
  it("omits bundled workspace packages and materializes catalog versions", () => {
    expect(
      resolveBundledPackageDependencies(
        {
          "@cafecode/shared": "workspace:*",
          effect: "catalog:",
          electron: "42.2.0",
        },
        { effect: "4.0.0-beta.59" },
        "fixture",
      ),
    ).toEqual({ effect: "4.0.0-beta.59", electron: "42.2.0" });
  });
});

describe("resolveNpmOverrides", () => {
  it("omits Yarn descriptor keys and unwraps patch locators", () => {
    expect(
      resolveNpmOverrides(
        {
          effect: "patch:effect@npm%3A4.0.0-beta.59#./.yarn/patches/effect.patch",
          hono: "^4.12.25",
          "rolldown@npm:^1.0.0": "npm:1.0.2",
        },
        {},
        "fixture",
      ),
    ).toEqual({ effect: "4.0.0-beta.59", hono: "^4.12.25" });
  });
});
