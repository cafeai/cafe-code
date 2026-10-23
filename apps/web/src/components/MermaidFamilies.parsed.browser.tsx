import "../index.css";
import { describe, expect, it } from "vitest";
import { installMermaidFamilyCleanup } from "./mermaidFamilyCleanup.test.fixture";
import { MERMAID_FAMILY_FIXTURES } from "./mermaidFamilies.test.fixture";
import { admitsParsedFamily } from "./mermaidFamilyProbe.test.fixture";

installMermaidFamilyCleanup();

describe("new family pre-layout security admission", () => {
  it("does not accept an unfamiliar info version database", async () => {
    expect(await admitsParsedFamily("info")).toBe(true);
    expect(
      await admitsParsedFamily(
        "info",
        "diagram.db = { ...diagram.db, getVersion: () => '13.0.0' }; ",
      ),
    ).toBe(false);
  });

  it.each([
    {
      family: "journey",
      mutation: "diagram.db.getTasks = () => null;",
    },
    {
      family: "quadrantChart",
      mutation:
        "const native = diagram.db.getQuadrantData.bind(diagram.db); diagram.db.getQuadrantData = () => { const value = native(); value.points[0].x = Infinity; return value; };",
    },
    {
      family: "requirementDiagram",
      mutation: "diagram.db.getRequirements = () => [];",
    },
    {
      family: "gitGraph horizontal merge",
      mutation:
        "const native = diagram.db.getCommits.bind(diagram.db); diagram.db.getCommits = () => { const value = native(); value.values().next().value.seq = NaN; return value; };",
    },
    {
      family: "timeline",
      mutation: "diagram.db = { ...diagram.db, getTasks: () => [undefined] };",
    },
    {
      family: "sankey-beta",
      mutation:
        "const native = diagram.db.getLinks.bind(diagram.db); diagram.db.getLinks = () => { const value = native(); value[0].value = Infinity; return value; };",
    },
    {
      family: "block-beta",
      mutation:
        "const native = diagram.db.getBlocksFlat.bind(diagram.db); diagram.db.getBlocksFlat = () => { const value = native(); value[0].widthInColumns = 1000000000; return value; };",
    },
    {
      family: "packet relative lengths",
      mutation:
        "const native = diagram.db.getPacket.bind(diagram.db); diagram.db.getPacket = () => { const value = native(); value[0][0].bits = NaN; return value; };",
    },
    {
      family: "kanban",
      mutation:
        "const native = diagram.db.getData.bind(diagram.db); diagram.db.getData = () => { const value = native(); value.nodes[0].label = {}; return value; };",
    },
    {
      family: "radar-beta",
      mutation:
        "const native = diagram.db.getCurves.bind(diagram.db); diagram.db.getCurves = () => { const value = native(); value[0].entries[0] = Infinity; return value; };",
    },
    {
      family: "treemap-beta",
      mutation:
        "const native = diagram.db.getRoot.bind(diagram.db); diagram.db.getRoot = () => { const value = native(); value.children = [value]; return value; };",
    },
    {
      family: "mindmap",
      mutation:
        "const native = diagram.db.getMindmap.bind(diagram.db); diagram.db.getMindmap = () => { const value = native(); value.children = [value]; return value; };",
    },
    {
      family: "architecture-beta",
      mutation:
        "const native = diagram.db.getNodes.bind(diagram.db); diagram.db.getNodes = () => { const value = native(); value[0].icon = 'external:unqualified'; return value; };",
    },
    {
      family: "C4Context",
      mutation:
        "const native = diagram.db.getC4ShapeArray.bind(diagram.db); diagram.db.getC4ShapeArray = () => { const value = native(); value[0].label = { text: {} }; return value; };",
    },
    {
      family: "swimlane-beta",
      mutation:
        "const native = diagram.db.getData.bind(diagram.db); diagram.db.getData = () => { const value = native(); value.nodes[0].parentId = value.nodes[0].id; return value; };",
    },
    {
      family: "agentflow-beta",
      mutation:
        "const native = diagram.db.getVertices.bind(diagram.db); diagram.db.getVertices = () => { const value = native(); value.values().next().value.img = 'https://example.invalid/hidden'; return value; };",
    },
    {
      family: "usecase-beta",
      mutation: "diagram.db.getJsonNodes = () => new Map([['hidden', {}]]);",
    },
    {
      family: "eventmodeling",
      mutation:
        "const native = diagram.db.getState.bind(diagram.db); diagram.db.getState = () => { const value = native(); value.boxes[0].x = Infinity; return value; };",
    },
    {
      family: "venn-beta",
      mutation:
        "const native = diagram.db.getSubsetData.bind(diagram.db); diagram.db.getSubsetData = () => { const value = native(); value[0].size = Infinity; return value; };",
    },
    {
      family: "ishikawa-beta",
      mutation:
        "const native = diagram.db.getRoot.bind(diagram.db); diagram.db.getRoot = () => { const value = native(); value.children = [value]; return value; };",
    },
    {
      family: "wardley-beta",
      mutation:
        "const native = diagram.db.getWardleyData.bind(diagram.db); diagram.db.getWardleyData = () => { const value = native(); value.nodes[0].x = Infinity; return value; };",
    },
    {
      family: "cynefin-beta",
      mutation: "diagram.db.getDomains = () => ({});",
    },
    {
      family: "treeView-beta",
      mutation: "diagram.db.getCount = () => NaN;",
    },
    ...["railroad-beta", "railroad-ebnf-beta", "railroad-abnf-beta", "railroad-peg-beta"].map(
      (family) => ({
        family,
        mutation:
          "const native = diagram.db.getRules.bind(diagram.db); diagram.db.getRules = () => { const value = native(); value[0].definition = { type: 'sequence', elements: [] }; value[0].definition.elements = [value[0].definition]; return value; };",
      }),
    ),
  ])("fails closed before layout for changed $family parsed data", async ({ family, mutation }) => {
    const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
    expect(await admitsParsedFamily(fixture.source)).toBe(true);
    expect(await admitsParsedFamily(fixture.source, mutation)).toBe(false);
  });

  it.each(["swimlane-beta", "agentflow-beta", "usecase-beta"])(
    "refuses aggregate rank amplification in the real %s parsed contract",
    async (family) => {
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
      const getter = family === "usecase-beta" ? "getRelationships" : "getData";
      const edges = family === "usecase-beta" ? "value" : "value.edges";
      // Each rank is individually below the 250 limit. Their combined native
      // dummy-rank work is not, so an element-only bound cannot pass this case.
      const mutation = `const native = diagram.db.${getter}.bind(diagram.db);
        diagram.db.${getter} = () => { const value = native(); const edges = ${edges};
        edges[0].minlen = 125; edges[1].minlen = 126; return value; };`;
      expect(await admitsParsedFamily(fixture.source)).toBe(true);
      expect(await admitsParsedFamily(fixture.source, mutation)).toBe(false);
    },
  );

  it.for([
    {
      name: "journey task, section and distinct actors",
      source: (count: number) =>
        `journey\nsection Build\nCompile: 5: ${Array.from({ length: count }, (_, index) => `Actor${index}`).join(", ")}`,
      accepted: 248,
      rejected: 249,
    },
    {
      name: "timeline task and every event",
      source: (count: number) =>
        `timeline\n2026 : ${Array.from({ length: count }, (_, index) => `Event${index}`).join(" : ")}`,
      accepted: 249,
      rejected: 250,
    },
    {
      name: "gitGraph commits and native main branch",
      source: (count: number) =>
        `gitGraph\n${Array.from({ length: count }, (_, index) => `commit id: "Commit${index}"`).join("\n")}`,
      accepted: 249,
      rejected: 250,
    },
    {
      name: "requirement declarations",
      source: (count: number) =>
        `requirementDiagram\n${Array.from({ length: count }, (_, index) => `requirement R${index} {\nid: R${index}\ntext: Item\nrisk: low\nverifymethod: test\n}`).join("\n")}`,
      accepted: 250,
      rejected: 251,
    },
    {
      name: "sankey actual nodes along a directed path",
      source: (count: number) =>
        `sankey-beta\n\n${Array.from({ length: count - 1 }, (_, index) => `Node${index},Node${index + 1},1`).join("\n")}`,
      accepted: 250,
      rejected: 251,
    },
    {
      name: "mindmap native recursive depth independently of node count",
      source: (depth: number) =>
        `mindmap\nRoot\n${Array.from({ length: depth }, (_, index) => `${"  ".repeat(index + 1)}Depth${index}`).join("\n")}`,
      accepted: 64,
      rejected: 65,
    },
    {
      name: "Venn numerical solver circles independently of subset budget",
      source: (count: number) =>
        `venn-beta\n${Array.from({ length: count }, (_, index) => `set Circle${index}`).join("\n")}`,
      accepted: 8,
      rejected: 9,
    },
  ])(
    "counts $name before layout",
    async ({ source, accepted, rejected }, { signal, onTestFailed }) => {
      type Invocation = "accepted" | "rejected";
      type Phase =
        | "start"
        | "engine-entered"
        | "engine-returned"
        | "receiver-installed"
        | "fixture-ready"
        | "complete"
        | "failed";
      const started = performance.now();
      const observations: {
        readonly invocation: Invocation;
        readonly phase: Phase;
        readonly elapsedMs: number;
      }[] = [];
      const observe = (invocation: Invocation, phase: Phase) => {
        if (observations.length >= 16) return;
        const elapsed = performance.now() - started;
        observations.push({
          invocation,
          phase,
          elapsedMs: Number.isFinite(elapsed)
            ? Math.min(3_600_000, Math.max(0, Math.round(elapsed)))
            : 0,
        });
      };
      // Diagnostics distinguish the two original invocations without retaining
      // source, arbitrary identifiers, received errors or native result data.
      // The exact public owner is captured before either native probe starts.
      onTestFailed(() => {
        console.error("Synthetic parsed-family boundary phases", { observations });
      });
      let invocation: Invocation = "accepted";
      try {
        observe("accepted", "start");
        expect(
          await admitsParsedFamily(
            source(accepted),
            "",
            undefined,
            undefined,
            undefined,
            (phase) => observe("accepted", phase),
            true,
            signal,
          ),
        ).toBe(true);
        observe("accepted", "complete");
        invocation = "rejected";
        observe("rejected", "start");
        expect(
          await admitsParsedFamily(
            source(rejected),
            "",
            undefined,
            undefined,
            undefined,
            (phase) => observe("rejected", phase),
            true,
            signal,
          ),
        ).toBe(false);
        observe("rejected", "complete");
      } catch (error) {
        observe(invocation, "failed");
        // Preserve the original transport/parser assertion error and budget;
        // observing an expired/retired invocation never becomes a refusal pass.
        throw error;
      }
    },
  );
});
