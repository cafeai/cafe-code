import { expect, it } from "vitest";
import { buildCafeCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

it("advertises the implemented image contract and composes server custom instructions separately", () => {
  const text = buildCafeCodexDeveloperInstructions({
    cwd: "/repo",
    additionalDirectories: ["/charts"],
    customInstructions: "  Be concise.\nUse metric units.  ",
  });
  expect(text).toContain("<app-context>");
  expect(text).toContain("![Description](/absolute/path/to/image.png)");
  expect(text).toContain('"/repo"\n"/charts"');
  expect(text).toContain("authenticated remote viewers");
  expect(text).toContain(
    "<user-instructions>\nBe concise.\nUse metric units.\n</user-instructions>",
  );
  expect(text).not.toContain("publish_image");
  expect(
    buildCafeCodexDeveloperInstructions({ cwd: "/repo", customInstructions: " \n " }),
  ).not.toContain("<user-instructions>");
});
