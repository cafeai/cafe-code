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

// Preserve a complete branching-and-joining topology around the standalone
// LINK identifier. Its quoted label and ordinary edge must not be mistaken
// for a link directive, and authored hard breaks must stay inert SVG text.
const BRANCHED_FLOWCHART = `flowchart TD
    PUB["Published workflow<br/>Task catalog and timing"]
    PRIV["Submitted work items"]
    PUB --> COMPILE["Prepare work schedule"]
    COMPILE --> ADMIT["Validate request"]
    PRIV --> ADMIT
    ADMIT --> EXEC["Run scheduled tasks"]
    EXEC --> TRANS["Record completed stage"]
    TRANS --> REPLAY["Review output and inputs"]
    REPLAY --> ROUTE["Route tasks<br/>Apply routing rules"]
    ROUTE --> ARITH["Primary team<br/>Planning and assignments"]
    ROUTE --> BIN["Secondary team<br/>Messages and documents"]
    ROUTE --> REDUCE["Sources<br/>Teams<br/>Schedule"]
    REDUCE --> TEMPLATE["Delivery template<br/>Packages and handover plan"]
    TEMPLATE --> B0["Shared work log"]
    B0 --> ARITH
    ARITH --> FUNC["Primary task summary"]
    FUNC --> LINK["Link audit<br/>Task checks"]
    B0 --> LINK
    BIN --> PLAN["Final delivery plan"]
    LINK --> PLAN
    PLAN --> SC["Schedule checks"]
    B0 --> OPEN["Shared project checklist<br/>Readiness and handover checks"]
    SC --> OPEN
    OPEN --> ART["Completed delivery package"]
    PUB --> VER["Review published plan"]
    ART --> VER
    VER --> RESULT["Approve or reject"]`;

// These fixtures retain the chart grammar and numeric shapes used in authored
// messages while keeping their labels synthetic. Actual chart geometry matters:
// an admitted source or a title-only SVG would not establish renderer support.
const XY_EXAMPLES = [
  {
    name: "categorical decimal bars",
    source: `xychart-beta
    title "Measured totals and forecast"
    x-axis ["Baseline A", "Baseline B", "Forecast", "Target"]
    y-axis "Decimal units" 0 --> 2400
    bar [2262.804, 2174.792, 360, 400]`,
    labels: ["Measured totals and forecast", "Baseline A", "Baseline B", "Decimal units"],
    bars: 4,
    lines: 0,
    relativeBarValues: [2262.804, 2174.792, 360, 400],
    lineValues: [],
    horizontal: false,
  },
  {
    name: "numeric range with labeled line points",
    source: `xychart-beta
    title "Signal measurements"
    x-axis "Elapsed seconds" -2 --> 2
    y-axis "Signal" -10 --> 10
    line "Observed" [-4 "Initial", 0 "Center", 7 "Final"]`,
    labels: ["Signal measurements", "Elapsed seconds", "Signal", "Initial", "Center", "Final"],
    bars: 0,
    lines: 1,
    relativeBarValues: [],
    lineValues: [-4, 0, 7],
    horizontal: false,
  },
  {
    name: "horizontal bars and line",
    source: `xychart-beta horizontal
    title "Regional deliveries"
    x-axis "Region" [North, East, South]
    y-axis "Deliveries" 0 --> 100
    bar "Completed" [20, 50, 80]
    line "Planned" [30, 60, 90]`,
    labels: ["Regional deliveries", "Region", "North", "East", "South", "Deliveries"],
    bars: 3,
    lines: 1,
    relativeBarValues: [20, 50, 80],
    lineValues: [30, 60, 90],
    horizontal: true,
  },
  {
    name: "stable XY declaration with automatic axes",
    source: `xychart
    title "Automatic chart axes"
    bar [3, 6, 9]`,
    labels: ["Automatic chart axes"],
    bars: 3,
    lines: 0,
    relativeBarValues: [3, 6, 9],
    lineValues: [],
    horizontal: false,
  },
] as const;

const PIE_EXAMPLES = [
  {
    name: "labeled slices",
    source: `pie
    title Resource shares
    "Compute" : 25
    "Storage" : 75`,
    labels: ["Resource shares", "Compute", "Storage", "25%", "75%"],
    slices: 2,
    legends: ["Compute", "Storage"],
  },
  {
    name: "showData with an unquoted colon title and a small entry",
    source: `pie showData
    title Resource allocation: exact unit composition
    "Primary pool" : 610698
    "Secondary pool" : 1563944
    "Header bytes" : 150`,
    labels: ["Resource allocation: exact unit composition", "28%", "72%"],
    // The pinned renderer intentionally omits paths below 1%, but keeps every
    // legend entry. Check the tiny entry's exact value instead of demanding a
    // third path that the real engine does not produce.
    slices: 2,
    legends: ["Primary pool [610698]", "Secondary pool [1563944]", "Header bytes [150]"],
  },
] as const;

function chartSvg(svg: string): { parsed: Document; labels: string; presentation: string } {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(parsed.querySelector("parsererror")).toBeNull();
  expect(parsed.querySelector("foreignObject,script,image,a,use")).toBeNull();
  // Renderer IDs vary on every sandbox render. Compare actual declarations
  // and drawing colors so theme coverage cannot pass merely because IDs differ.
  const presentation: string[] = [];
  for (const style of parsed.querySelectorAll("style")) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style.textContent ?? "");
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSStyleRule) presentation.push(rule.style.cssText);
    }
    style.remove();
  }
  for (const element of parsed.querySelectorAll("[fill], [stroke]")) {
    presentation.push(`${element.getAttribute("fill")}:${element.getAttribute("stroke")}`);
  }
  const text = document.createTreeWalker(parsed, NodeFilter.SHOW_TEXT);
  const labels: string[] = [];
  while (text.nextNode()) labels.push(text.currentNode.textContent ?? "");
  return {
    parsed,
    labels: labels.join(" ").replace(/\s+/g, " "),
    presentation: presentation.join("\n"),
  };
}

async function decodeChartImage(svg: string): Promise<void> {
  // Decode the same inert image type the chat UI displays. DOM parsing alone
  // would miss SVG that survives sanitization but cannot become a usable image.
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    expect(image.naturalWidth).toBeGreaterThan(0);
    expect(image.naturalHeight).toBeGreaterThan(0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function expectRelativeValues(magnitudes: readonly number[], values: readonly number[]): void {
  expect(magnitudes).toHaveLength(values.length);
  if (values.length < 2) return;
  const minimumMagnitude = Math.min(...magnitudes);
  const magnitudeRange = Math.max(...magnitudes) - minimumMagnitude;
  const minimumValue = Math.min(...values);
  const valueRange = Math.max(...values) - minimumValue;
  expect(magnitudeRange).toBeGreaterThan(0);
  for (const [index, value] of values.entries()) {
    // Automatic domains and axis padding add an offset to drawing extents.
    // Differences preserve a linear scale's source proportions, including
    // decimals, without imposing a synthetic zero baseline.
    expect((magnitudes[index]! - minimumMagnitude) / magnitudeRange).toBeCloseTo(
      (value - minimumValue) / valueRange,
      3,
    );
  }
}

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

  it("renders a complete multiline branching flowchart with a standalone LINK node", async () => {
    for (const theme of ["dark", "light"] as const) {
      const result = await renderMermaid(BRANCHED_FLOWCHART, theme);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      const { parsed, labels } = chartSvg(result.svg);
      const nodes = Array.from(parsed.querySelectorAll(".nodes .node"));
      expect(nodes).toHaveLength(21);
      expect(parsed.querySelectorAll(".edgePaths .flowchart-link")).toHaveLength(25);
      for (const label of [
        "Published workflow",
        "Task catalog and timing",
        "Final delivery plan",
        "Schedule",
        "Approve or reject",
      ])
        expect(labels).toContain(label);
      for (const expectedLines of [
        ["Link audit", "Task checks"],
        ["Sources", "Teams", "Schedule"],
      ] as const) {
        // Generated node IDs are renderer internals, not a label identity
        // contract. Bind one exact semantic label within the complete graph,
        // then independently require every authored hard-break row in order.
        const matching = nodes.filter(
          (node) =>
            node.querySelector("text > tspan")?.textContent?.replace(/\s+/g, " ").trim() ===
            expectedLines[0],
        );
        expect(matching).toHaveLength(1);
        const lines = Array.from(matching[0]!.querySelectorAll("text > tspan"), (line) =>
          line.textContent?.replace(/\s+/g, " ").trim(),
        );
        expect(lines).toEqual([...expectedLines]);
      }
      expect(result.svg).not.toMatch(/<br\b|&lt;br\b|href=|onclick=/i);
      await decodeChartImage(result.svg);
    }
    expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
  });

  it.each(XY_EXAMPLES)(
    "renders $name as real XY chart geometry in both themes",
    async (example) => {
      const themed: string[] = [];
      for (const theme of ["dark", "light"] as const) {
        const result = await renderMermaid(example.source, theme);
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
        const { parsed, labels, presentation } = chartSvg(result.svg);
        for (const label of example.labels) expect(labels).toContain(label);
        const bars = Array.from(parsed.querySelectorAll(".plot [class^='bar-plot-'] rect"));
        const lines = Array.from(parsed.querySelectorAll(".plot [class^='line-plot-'] path"));
        expect(bars).toHaveLength(example.bars);
        expect(lines).toHaveLength(example.lines);
        for (const bar of bars) {
          for (const dimension of ["width", "height"] as const) {
            const extent = Number(bar.getAttribute(dimension));
            expect(Number.isFinite(extent)).toBe(true);
            expect(extent).toBeGreaterThan(0);
          }
        }
        const magnitudes = bars.map((bar) =>
          Number(bar.getAttribute(example.horizontal ? "width" : "height")),
        );
        expectRelativeValues(magnitudes, example.relativeBarValues);
        for (const line of lines) {
          const path = line.getAttribute("d") ?? "";
          expect(path).toMatch(/^M/);
          expect(path).not.toMatch(/NaN|Infinity/);
          const points = Array.from(
            path.matchAll(/[ML](-?(?:\d+(?:\.\d*)?|\.\d+)),(-?(?:\d+(?:\.\d*)?|\.\d+))/g),
            (point) => [Number(point[1]), Number(point[2])] as const,
          );
          expect(points).toHaveLength(example.lineValues.length);
          for (const point of points) expect(point.every(Number.isFinite)).toBe(true);
          const categoryPositions = points.map((point) => point[example.horizontal ? 1 : 0]);
          expect(new Set(categoryPositions).size).toBe(example.lineValues.length);
          expect(categoryPositions[1]).toBeCloseTo(
            (categoryPositions[0]! + categoryPositions[2]!) / 2,
            2,
          );
          // SVG's vertical coordinates run downward. Reverse that coordinate
          // only for a vertical chart before comparing the actual series values.
          expectRelativeValues(
            points.map((point) => (example.horizontal ? point[0] : -point[1])),
            example.lineValues,
          );
        }
        if (example.horizontal) {
          const categoryLabels = parsed.querySelector(".left-axis .label")?.textContent ?? "";
          expect(categoryLabels).toContain("North");
          const widths = bars.map((bar) => Number(bar.getAttribute("width")));
          expect(widths[0]).toBeLessThan(widths[1]!);
          expect(widths[1]).toBeLessThan(widths[2]!);
        }
        await decodeChartImage(result.svg);
        themed.push(presentation);
      }
      expect(themed[0]).not.toBe(themed[1]);
      expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
    },
  );

  it.each(PIE_EXAMPLES)(
    "renders $name as real pie slices and legends in both themes",
    async (example) => {
      const themed: string[] = [];
      for (const theme of ["dark", "light"] as const) {
        const result = await renderMermaid(example.source, theme);
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
        const { parsed, labels, presentation } = chartSvg(result.svg);
        for (const label of example.labels) expect(labels).toContain(label);
        const slices = Array.from(parsed.querySelectorAll("path.pieCircle"));
        expect(slices).toHaveLength(example.slices);
        for (const slice of slices) {
          expect(slice.getAttribute("d")).toMatch(/^M/);
          expect(slice.getAttribute("d")).not.toMatch(/NaN|Infinity/);
        }
        const legends = Array.from(
          parsed.querySelectorAll(".legend text"),
          (text) => text.textContent,
        );
        expect(legends).toHaveLength(example.legends.length);
        expect(legends).toEqual(expect.arrayContaining([...example.legends]));
        await decodeChartImage(result.svg);
        themed.push(presentation);
      }
      expect(themed[0]).not.toBe(themed[1]);
      expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
    },
  );

  it("rejects malformed, unsupported and oversized graphs without poisoning the queue", async () => {
    for (const source of [
      "flowchart TD\nA[unterminated",
      "gantt\nsection Build\nCompile :a, 2026-01-01, 1d",
      "xychart-beta\nbar [1, broken]",
      'pie\n"a" nope',
      `flowchart TD\n${Array.from({ length: 251 }, (_, i) => `n${i}[Node]`).join("\n")}`,
      `sequenceDiagram\n${Array.from({ length: 251 }, (_, i) => `participant n${i}`).join("\n")}`,
      `xychart-beta\nbar [${Array.from({ length: 251 }, () => 1).join(",")}]`,
      `pie\n${Array.from({ length: 251 }, (_, i) => `"Section ${i}":1`).join("\n")}`,
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
