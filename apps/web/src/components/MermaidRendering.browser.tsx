import "../index.css";
import { describe, expect, it } from "vitest";
import { renderMermaid } from "../lib/mermaid/renderService";
import { sanitizeMermaidSvg } from "../lib/mermaid/sanitizeSvg";

const EXAMPLE = `flowchart TD
    I["Program + public inputs + protected private inputs"] --> A["Compile and admit original sources through CHL"]
    A --> R["Execute the registered VM"]
    R --> T["Admit the claimed transition through CHL"]
    T --> C["Independent replay + faithful CCS constraints"]
    C --> M["Native M31 proof component"]
    C --> B["Characteristic-two proof component"]
    M --> L["Authenticated links between the same canonical objects"]
    B --> L
    L --> P["One aggregate proof artifact"]
    P --> V["Independent verifier"]
    E["Independently expected public statement"] --> V`;

describe("real isolated Mermaid rendering", () => {
  it("sanitizes a basic SVG", () => {
    expect(
      sanitizeMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="1" y="10">hello</text></svg>',
      ).width,
    ).toBe(100);
  });
  it.each([
    ["flowchart", EXAMPLE, "Independent verifier"],
    ["sequence", "sequenceDiagram\nAlice->>Bob: Hello", "Hello"],
    ["class", "classDiagram\nAnimal <|-- Duck\nAnimal : +int age", "Animal"],
    ["state", "stateDiagram-v2\n[*] --> Ready\nReady --> Done", "Ready"],
    ["ER", "erDiagram\nCUSTOMER ||--o{ ORDER : places", "CUSTOMER"],
  ])("renders %s locally as a sanitized image", async (_family, source, label) => {
    for (const theme of ["dark", "light"] as const) {
      const result = await renderMermaid(source, theme);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
      for (const style of parsed.querySelectorAll("style")) style.remove();
      const text = document.createTreeWalker(parsed, NodeFilter.SHOW_TEXT);
      const labels: string[] = [];
      while (text.nextNode()) labels.push(text.currentNode.textContent ?? "");
      expect(labels.join(" ").replace(/\s+/g, " ")).toContain(label);
      expect(result.svg).not.toMatch(/<foreignObject|<script|<image|<a\s|href=/);
      const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        expect(image.naturalWidth).toBeGreaterThan(0);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
  });

  it("rejects malformed, unsupported and oversized graphs without poisoning the queue", async () => {
    for (const source of [
      "flowchart TD\nA[unterminated",
      'pie\n"a":1',
      `flowchart TD\n${Array.from({ length: 251 }, (_, i) => `n${i}[Node]`).join("\n")}`,
      `sequenceDiagram\n${Array.from({ length: 251 }, (_, i) => `participant n${i}`).join("\n")}`,
    ])
      await expect(renderMermaid(source, "dark")).rejects.toThrow("Diagram unavailable");
    expect((await renderMermaid("flowchart LR\nA-->B", "dark")).svg).toContain("<svg");
  });

  it("lays out a substantial admitted graph with the real bundled engine", async () => {
    // Exercise real layout near the admission boundary, not only the parser or
    // a mocked renderer. Avoid a timing assertion tied to the CI host's load.
    const source = `flowchart TD\n${Array.from({ length: 239 }, (_, i) => `n${i}-->n${i + 1}`).join("\n")}`;
    const result = await renderMermaid(source, "light");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.svg).toContain("n239");
    expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
  });

  it("retains accessibility text and disables interactive syntax", async () => {
    const result = await renderMermaid(
      "graph TD\naccTitle: Build pipeline\naccDescr: Inputs produce a proof\nA-->B",
      "dark",
    );
    expect(result.title).toContain("Build pipeline");
    expect(result.title).toContain("Inputs produce a proof");
    expect(result.svg).not.toMatch(/href=|<a\s|onclick=|<script/);
  });
});
