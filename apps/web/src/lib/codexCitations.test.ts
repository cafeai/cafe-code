import { describe, expect, it } from "vitest";
import { normalizeCodexCitationMarkers } from "./codexCitations";

describe("normalizeCodexCitationMarkers", () => {
  it("turns Codex private-use citation spans into compact display markers", () => {
    const text =
      "See Turner. \uE200cite\uE202turn4academia13\uE201 \uE200cite\uE202turn4search3\uE201";

    expect(normalizeCodexCitationMarkers(text, { mode: "display" })).toBe("See Turner. [1] [2]");
  });

  it("reuses display marker numbers for repeated citation handles", () => {
    const text =
      "First \uE200cite\uE202turn3view0\uE201 then again \uE200cite\uE202turn3view0\uE201.";

    expect(normalizeCodexCitationMarkers(text, { mode: "display" })).toBe(
      "First [1] then again [1].",
    );
  });

  it("strips citation spans from copied text", () => {
    const text = "Prismatic cohomology \uE200cite\uE202turn3view2\uE201 remains nearby.";

    expect(normalizeCodexCitationMarkers(text, { mode: "strip" })).toBe(
      "Prismatic cohomology remains nearby.",
    );
  });

  it("suppresses partial streaming citation markers until they complete", () => {
    const text = "Streaming source \uE200cite\uE202turn3";

    expect(normalizeCodexCitationMarkers(text, { mode: "display" })).toBe("Streaming source ");
  });
});
