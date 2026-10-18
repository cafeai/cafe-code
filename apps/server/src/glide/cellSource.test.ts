import { describe, expect, it } from "vitest";
import { parse } from "acorn";
import { prepareCellSource } from "./cellSource.ts";

describe("persistent Glide cell source", () => {
  it("carries mutable values and exports top-level destructuring, functions and classes", () => {
    const result = prepareCellSource(
      "const {a, nested: [b, ...rest]} = data; let [c] = rest; function f() { let local = 1; return local; } class C {}",
      ["data", "earlier"],
    );
    expect(result.names).toEqual(["data", "earlier", "a", "b", "rest", "c", "f", "C"]);
    expect(() => parse(result.code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  });
  it("allows later redeclaration without importing the shadowed binding", () => {
    const result = prepareCellSource("const x = 2; x;", ["x", "y"]);
    expect(result.names).toEqual(["y", "x"]);
    expect(result.code).not.toContain("let x =");
    expect(() => parse(result.code, { ecmaVersion: "latest", sourceType: "module" })).not.toThrow();
  });
  it("persists module var declarations in blocks and excludes nested lexical/function scope", () => {
    const result = prepareCellSource(
      "if (true) { var visible = 1; let hidden = 2; } const fn = () => { var inner = 3; };",
      [],
    );
    expect(result.names).toEqual(["visible", "fn"]);
  });
  it("does not interpret declaration-looking strings or comments as bindings", () => {
    expect(
      prepareCellSource("// const fake = 1;\n'let other = 2'; await Promise.resolve();", []).names,
    ).toEqual([]);
  });
  it("carries imported local names and rejects exports reserved for the kernel", () => {
    expect(prepareCellSource('import { sky as driver } from "@oai/sky";', []).names).toEqual([
      "driver",
    ]);
    expect(() => prepareCellSource("export const x = 1;", [])).toThrow("reserved");
    expect(() => prepareCellSource("let __cafe_previous = 1;", [])).toThrow("reserved");
    expect(() => prepareCellSource('import * as previous from "cafe:previous";', [])).toThrow(
      "reserved",
    );
  });
});
