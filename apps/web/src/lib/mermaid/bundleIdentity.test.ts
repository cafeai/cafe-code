import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { MERMAID_POLICY } from "./policy";

const require = createRequire(import.meta.url);

describe("qualified offline Mermaid engine identity", () => {
  it("binds the local full12 IIFE to the reviewed engine and cache policy", () => {
    // The emitted IIFE has its own compiled dependency graph. Installing a
    // matching top-level version is not sufficient evidence that database
    // contracts or embedded engines still match our pre-layout admission.
    // Deliberate renderer upgrades must renew this identity and all adapters;
    // never update the hash alone to make an unreviewed distribution pass.
    const bundle = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"));
    expect(bundle.byteLength).toBe(5_575_485);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(
      "28fca7ae6ebc7ed7bb63bde63136a74bfef14f296a57e403657eeb8b32836073",
    );
    expect(MERMAID_POLICY).toBe("full-12.0.0/cafe-4");
    // No lazy network chunk loading is needed in this self-contained build.
    expect(bundle.toString("utf8")).not.toMatch(/\bimport\s*\(/);
  });

  it("keeps the reviewed baked Lodash advisory entrypoints absent", () => {
    // A Yarn resolution updates installed ESM dependencies, never a prebuilt
    // IIFE. Bind the actual published source map separately: older helpers
    // remain baked, but the template compilation and unset/omit prototype
    // deletion entrypoints are absent from this reviewed tree-shaken artifact.
    // This narrow finding is not a universal upstream vulnerability claim.
    const map = readFileSync(require.resolve("mermaid/dist/mermaid.min.js.map"));
    expect(createHash("sha256").update(map).digest("hex")).toBe(
      "b92ab7885a856caee67c64031fa02ff60e59d0ec540b77b5de3d85cae4b36401",
    );
    const { sources, sourcesContent } = JSON.parse(map.toString("utf8")) as {
      sources: string[];
      sourcesContent: string[];
    };
    expect(sources).toHaveLength(1471);
    expect(sourcesContent).toHaveLength(sources.length);
    const lodash = sources.filter((source) => /lodash-es@4\.(?:17\.23|18\.1)\//.test(source));
    expect(lodash).toHaveLength(469);
    expect(lodash.filter((source) => /@4\.17\.23\//.test(source))).toHaveLength(229);
    for (const file of ["template", "templateSettings", "unset", "omit", "_baseUnset", "_parent"])
      expect(lodash.some((source) => source.endsWith(`/${file}.js`))).toBe(false);
    const engineRequire = createRequire(require.resolve("mermaid/package.json"));
    const parserRequire = createRequire(engineRequire.resolve("chevrotain"));
    // Scope the patch to the newly introduced exact Chevrotain descriptor;
    // unrelated repository dependencies are not silently refreshed here.
    const installed = JSON.parse(
      readFileSync(parserRequire.resolve("lodash-es/package.json"), "utf8"),
    ) as {
      version: string;
    };
    expect(installed.version).toBe("4.18.1");
  });
});
