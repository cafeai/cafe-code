import { transformAsync } from "@babel/core";
import { describe, expect, it } from "vitest";
import { reactCompilerConfig } from "../reactCompilerConfig.ts";

// Exercise Babel 8 with the real production parser options and unchanged React
// compiler preset. The Rolldown wrapper carries an additional filter descriptor;
// direct Babel transforms receive its inner preset, just as that wrapper does.
const transform = (source: string, filename: string) =>
  transformAsync(source, {
    ...reactCompilerConfig,
    filename,
    configFile: false,
    babelrc: false,
    presets: reactCompilerConfig.presets.map((preset) => preset.preset),
  });

describe("Babel 8 / React compiler compatibility", () => {
  it("parses shared-workspace generic arrows without interpreting them as JSX", async () => {
    const output = await transform(
      "export const identity = <A>(value: A): A => value;",
      "/fixture/packages/shared/src/generic.ts",
    );
    expect(output?.code).toContain("identity");
    expect(output?.code).toContain("=> value");
  });

  it("compiles typed React JSX through the real production preset", async () => {
    const output = await transform(
      "export function Summary({ value }: { value: number }) { return <span>{value * 2}</span>; }",
      "/fixture/apps/web/src/Summary.tsx",
    );
    expect(output?.code).toContain("react/compiler-runtime");
    expect(output?.code).toContain("<span>");
  });

  it("supports unambiguous TSX generic arrows alongside JSX", async () => {
    const output = await transform(
      "const identity = <A,>(value: A): A => value; export function Summary() { return <span>{identity(2)}</span>; }",
      "/fixture/apps/web/src/Summary.tsx",
    );
    expect(output?.code).toContain("identity");
    expect(output?.code).toContain("<span>");
  });
});
