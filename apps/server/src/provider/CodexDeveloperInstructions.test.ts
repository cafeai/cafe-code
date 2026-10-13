import { expect, it } from "vitest";
import {
  buildCafeCodexDeveloperInstructions,
  CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS,
} from "./CodexDeveloperInstructions.ts";
import { GENERATED_VISUALIZATION_INSTRUCTIONS } from "../visualizations/mcp.ts";

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

it("keeps a bounded pre-authoring reminder while the complete generation contract stays in tool metadata", () => {
  expect(Buffer.byteLength(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS, "utf8")).toBeLessThan(1024);
  expect(Buffer.byteLength(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS, "utf8")).toBeLessThan(
    Buffer.byteLength(GENERATED_VISUALIZATION_INSTRUCTIONS, "utf8"),
  );
  expect(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS).toContain(
    "Before authoring any visualization, find this tool in the supplied definitions or discover it with the available tool search/catalog, and read its complete description.",
  );
  expect(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS).toContain("the user's visual requirements");
  expect(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS).toContain(
    "current persisted Full access permits",
  );
  expect(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS).toContain(
    "missing/restricted access fails closed",
  );
  expect(CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS).not.toContain(
    GENERATED_VISUALIZATION_INSTRUCTIONS,
  );
});
