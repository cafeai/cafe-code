import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import source from "./extendedFamilyAdmission.js?raw";

type Size = (type: string, db: unknown, source: string) => [number, number] | undefined;

// Evaluate the exact inert sandbox script in a fresh synthetic realm, never by
// importing Mermaid into the app or touching a provider/session/profile.
function admission(): Size {
  const globalThis: { cafeMermaidExtendedFamilySize?: Size } = {};
  runInNewContext(source, { globalThis, Map, Set, Object, Array, Number, JSON, Error });
  return globalThis.cafeMermaidExtendedFamilySize!;
}

function treeNode(id: number, children: object[] = []) {
  return { id, nodeId: `n${id}`, descr: `Node ${id}`, level: id, type: 0, children };
}

function graph() {
  return {
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    edges: [{ start: "a", end: "b", minlen: 1 }],
  };
}

function architecture() {
  type Edge = { lhsId: string; rhsId: string; lhsDir: string; rhsDir: string };
  const nodes = [
    { id: "app", type: "service", icon: "server", in: "platform", edges: [] as Edge[] },
    { id: "db", type: "service", icon: "database", in: "platform", edges: [] as Edge[] },
  ];
  const groups = [{ id: "platform", icon: "cloud", title: "Platform" }];
  const edges = [{ lhsId: "app", rhsId: "db", lhsDir: "R", rhsDir: "L" }];
  nodes[0]!.edges.push(edges[0]!);
  nodes[1]!.edges.push(edges[0]!);
  const hints: object[] = [];
  return {
    nodes,
    groups,
    edges,
    hints,
    db: {
      getNodes: () => nodes,
      getGroups: () => groups,
      getEdges: () => edges,
      getLayoutHints: () => hints,
    },
  };
}

function c4() {
  const shapes = [
    {
      alias: "app",
      label: { text: "App" },
      parentBoundary: "global",
      typeC4Shape: { text: "system" },
    },
  ];
  const boundaries = [
    { alias: "global", label: { text: "Global" }, type: { text: "global" }, parentBoundary: "" },
  ];
  const relations: object[] = [];
  return {
    shapes,
    boundaries,
    relations,
    db: {
      getC4ShapeArray: () => shapes,
      getBoundaries: () => boundaries,
      getRels: () => relations,
      getC4ShapeInRow: () => 4,
      getC4BoundaryInRow: () => 2,
    },
  };
}

function wardley() {
  return {
    nodes: [{ id: "app", label: "App", x: 50, y: 80 }],
    links: [],
    trends: [],
    pipelines: [],
    annotations: [],
    notes: [],
    accelerators: [],
    deaccelerators: [],
    axes: {},
  };
}

describe("pinned extended Mermaid database admission", () => {
  it("binds native Event source references before allocating state, including parser-accepted unresolved and forward IDs", async () => {
    // Load the local parser from the exact pinned engine dependency closure,
    // never an ambient global package or a substitute grammar. Native parse alone does not
    // reject these unresolved/forward references; admission must do so before
    // getState silently drops the authored relationship.
    const parser = await import("@mermaid-js/parser");
    const unresolved = "eventmodeling tf 01 ui Task ->> 99";
    const forward = "eventmodeling tf 01 ui Task ->> 02 tf 02 evt Event";
    const backward = "eventmodeling tf 01 ui Task tf 02 evt Event ->> 01";
    expect(
      (await parser.parse("eventmodeling", unresolved)).frames[0]!.sourceFrames[0]!.$refText,
    ).toBe("99");
    expect(
      (await parser.parse("eventmodeling", forward)).frames[0]!.sourceFrames[0]!.$refText,
    ).toBe("02");
    expect(
      (await parser.parse("eventmodeling", backward)).frames[1]!.sourceFrames[0]!.$refText,
    ).toBe("01");
    const getState = vi.fn(() => ({
      boxes: ["Task", "Event"].map((text, index) => ({
        text,
        r: 0,
        x: 0,
        y: 0,
        index,
        dimension: { width: 80, height: 80 },
      })),
      swimlanes: {},
      relations: [],
    }));
    const size = admission();
    expect(size("eventmodeling", { getState }, backward)).toEqual([2, 0]);
    expect(getState).toHaveBeenCalledTimes(1);
    getState.mockClear();
    for (const input of [unresolved, forward])
      expect(() => size("eventmodeling", { getState }, input)).toThrow();
    expect(getState).not.toHaveBeenCalled();
  });

  it("counts raw mindmap trees before recursive layout and rejects cycles, icons, depth and overflow", () => {
    const size = admission();
    const root = treeNode(0, [treeNode(1), treeNode(2)]);
    expect(size("mindmap", { getMindmap: () => root }, "mindmap")).toEqual([3, 2]);
    const cyclic = treeNode(0);
    cyclic.children.push(cyclic);
    expect(() => size("mindmap", { getMindmap: () => cyclic }, "mindmap")).toThrow();
    expect(() =>
      size("mindmap", { getMindmap: () => ({ ...root, icon: "remote:icon" }) }, "mindmap"),
    ).toThrow();
    expect(() =>
      size(
        "mindmap",
        {
          getMindmap: () =>
            treeNode(
              0,
              Array.from({ length: 250 }, (_, i) => treeNode(i + 1)),
            ),
        },
        "mindmap",
      ),
    ).toThrow();
    let deep = treeNode(65);
    for (let i = 64; i >= 0; i--) deep = treeNode(i, [deep]);
    expect(() => size("mindmap", { getMindmap: () => deep }, "mindmap")).toThrow();
  });

  it("binds treeView's synthetic root/count and permits only bundled glyphs", () => {
    const size = admission();
    const root = {
      id: 0,
      name: "/",
      nodeType: "directory",
      children: [{ id: 1, name: "app.ts", nodeType: "file", icon: "file", children: [] }],
    };
    expect(size("treeView", { getRoot: () => root, getCount: () => 2 }, "treeView-beta")).toEqual([
      2, 1,
    ]);
    expect(() =>
      size("treeView", { getRoot: () => root, getCount: () => 1 }, "treeView-beta"),
    ).toThrow();
    root.children[0]!.icon = "external:typescript";
    expect(() =>
      size("treeView", { getRoot: () => root, getCount: () => 2 }, "treeView-beta"),
    ).toThrow();
  });

  it("admits local architecture glyphs and refuses foreignObject icons, external packs, bad references and parent cycles", () => {
    const size = admission();
    const valid = architecture();
    expect(size("architecture", valid.db, "architecture-beta")).toEqual([3, 1]);
    valid.nodes[0]!.icon = "remote:server";
    expect(() => size("architecture", valid.db, "architecture-beta")).toThrow();
    valid.nodes[0]!.icon = "server";
    Object.assign(valid.nodes[0]!, { iconText: "Unsafe label" });
    expect(() => size("architecture", valid.db, "architecture-beta")).toThrow();
    const cycle = architecture();
    Object.assign(cycle.groups[0]!, { in: "platform" });
    expect(() => size("architecture", cycle.db, "architecture-beta")).toThrow();
    const missing = architecture();
    missing.edges[0]!.rhsId = "absent";
    expect(() => size("architecture", missing.db, "architecture-beta")).toThrow();
  });

  it("bounds architecture's native duplicate-dequeue BFS before its allocating getter", () => {
    const size = admission();
    type Edge = { lhsId: string; rhsId: string; lhsDir: string; rhsDir: string };
    const nodes: { id: string; type: string; edges: Edge[] }[] = [];
    const edges: Edge[] = [];
    for (let layer = 0; layer < 10; layer++) {
      for (let branch = 0; branch < 2; branch++)
        nodes.push({ id: `n${layer}_${branch}`, type: "service", edges: [] });
      if (layer > 0)
        for (let branch = 0; branch < 2; branch++) {
          edges.push({
            lhsId: `n${layer - 1}_${branch}`,
            rhsId: `n${layer}_0`,
            lhsDir: "L",
            rhsDir: "R",
          });
          edges.push({
            lhsId: `n${layer - 1}_${branch}`,
            rhsId: `n${layer}_1`,
            lhsDir: "T",
            rhsDir: "B",
          });
          // Native processes self-edges through the lhs branch twice. A
          // predictor inventing a reverse T/B key here would incorrectly
          // shadow the real next-layer neighbor and miss the BFS explosion.
          edges.push({
            lhsId: `n${layer - 1}_${branch}`,
            rhsId: `n${layer - 1}_${branch}`,
            lhsDir: "B",
            rhsDir: "T",
          });
        }
    }
    for (const edge of edges) {
      nodes.find((node) => node.id === edge.lhsId)!.edges.push(edge);
      nodes.find((node) => node.id === edge.rhsId)!.edges.push(edge);
    }
    const getDataStructures = vi.fn(() => {
      throw new Error("Must not resolve");
    });
    expect(() =>
      size(
        "architecture",
        {
          getNodes: () => nodes,
          getGroups: () => [],
          getEdges: () => edges,
          getLayoutHints: () => [],
          getDataStructures,
        },
        "architecture-beta",
      ),
    ).toThrow();
    expect(getDataStructures).not.toHaveBeenCalled();
  });

  it("binds architecture incident edges to the exact global objects and authored order", () => {
    const size = admission();
    const valid = architecture();
    const second = { lhsId: "app", rhsId: "db", lhsDir: "T", rhsDir: "B" };
    valid.edges.push(second);
    for (const node of valid.nodes) node.edges.push(second);
    expect(size("architecture", valid.db, "architecture-beta")).toEqual([3, 2]);
    const self = { lhsId: "app", rhsId: "app", lhsDir: "B", rhsDir: "T" };
    valid.edges.push(self);
    valid.nodes[0]!.edges.push(self, self);
    expect(size("architecture", valid.db, "architecture-beta")).toEqual([3, 3]);
    valid.nodes[0]!.edges.reverse();
    expect(() => size("architecture", valid.db, "architecture-beta")).toThrow();
    valid.nodes[0]!.edges.reverse();
    valid.nodes[0]!.edges[0] = { ...valid.edges[0]! };
    expect(() => size("architecture", valid.db, "architecture-beta")).toThrow();
    const missing = architecture();
    missing.nodes[0]!.edges.pop();
    expect(() => size("architecture", missing.db, "architecture-beta")).toThrow();
  });

  it("counts all C4 boundaries, refuses source attributes that acquire resources, and validates native row budgets", () => {
    const size = admission();
    const valid = c4();
    expect(size("c4", valid.db, "C4Context")).toEqual([2, 0]);
    expect(() => size("c4", { ...valid.db, getC4ShapeInRow: () => 0 }, "C4Context")).toThrow();
    Object.assign(valid.shapes[0]!, { link: "https://example.invalid" });
    expect(() => size("c4", valid.db, "C4Context")).toThrow();
    const sprite = c4();
    Object.assign(sprite.boundaries[0]!, { sprite: "external.svg" });
    expect(() => size("c4", sprite.db, "C4Context")).toThrow();
    const malformed = c4();
    Object.setPrototypeOf(malformed.shapes[0]!, { image: "replacement" });
    expect(() => size("c4", malformed.db, "C4Context")).toThrow();
  });

  it("uses exact layout IR for swimlanes and refuses images, animated edges, unknown endpoints and cyclic containment", () => {
    const size = admission();
    expect(size("swimlane", { getData: graph }, "swimlane-beta LR")).toEqual([2, 1]);
    for (const node of [
      { icon: "remote:a" },
      { img: "https://example.invalid/a.png" },
      { shape: "imageSquare" },
    ]) {
      const model = graph();
      Object.assign(model.nodes[0]!, node);
      expect(() => size("swimlane", { getData: () => model }, "swimlane-beta LR")).toThrow();
    }
    const cycle = graph();
    Object.assign(cycle.nodes[0]!, { parentId: "b" });
    Object.assign(cycle.nodes[1]!, { parentId: "a" });
    expect(() => size("swimlane", { getData: () => cycle }, "swimlane-beta LR")).toThrow();
    const animated = graph();
    Object.assign(animated.edges[0]!, { animate: true });
    expect(() => size("swimlane", { getData: () => animated }, "swimlane-beta LR")).toThrow();
    const ranked = graph();
    ranked.edges = [
      { start: "a", end: "b", minlen: 125 },
      { start: "b", end: "a", minlen: 125 },
    ];
    expect(size("swimlane", { getData: () => ranked }, "swimlane-beta LR")).toEqual([2, 2]);
    ranked.edges[1]!.minlen = 126;
    expect(() => size("swimlane", { getData: () => ranked }, "swimlane-beta LR")).toThrow();
  });

  it("counts agentflow's collapsed raw content before visible layout, without executing it", () => {
    const size = admission();
    const vertices = new Map([
      ["a", { id: "a" }],
      ["b", { id: "b" }],
    ]);
    const getData = vi.fn(graph);
    const db = {
      getVertices: () => vertices,
      getSubGraphs: () => [],
      getEdges: () => [{ start: "a", end: "b" }],
      getData,
    };
    expect(size("agentflow", db, "agentflow-beta LR")).toEqual([2, 1]);
    getData.mockClear();
    for (let i = 0; i < 250; i++) vertices.set(`hidden${i}`, { id: `hidden${i}` });
    expect(() => size("agentflow", db, "agentflow-beta LR")).toThrow();
    expect(getData).not.toHaveBeenCalled();
  });

  it("qualifies usecase native counts while refusing custom actor icons, JSON flattening, animation and huge minlen", () => {
    const size = admission();
    const actors = new Map([["a", { id: "a", type: "normal" }]]);
    const uses = new Map([["b", { id: "b" }]]);
    const relationships = [{ minlen: 1 }];
    const db = {
      getActors: () => actors,
      getUseCases: () => uses,
      getSystemBoundaries: () => new Map(),
      getNotes: () => new Map(),
      getJsonNodes: () => new Map(),
      getRelationships: () => relationships,
      getData: graph,
    };
    expect(size("usecase", db, "usecase-beta")).toEqual([2, 1]);
    relationships[0]!.minlen = 251;
    expect(() => size("usecase", db, "usecase-beta")).toThrow();
    relationships[0]!.minlen = 125;
    relationships.push({ minlen: 126 });
    expect(() => size("usecase", db, "usecase-beta")).toThrow();
    relationships.pop();
    relationships[0]!.minlen = 1;
    actors.get("a")!.type = "icon";
    expect(() => size("usecase", db, "usecase-beta")).toThrow();
    actors.get("a")!.type = "normal";
    expect(() =>
      size("usecase", { ...db, getJsonNodes: () => new Map([["json", {}]]) }, "usecase-beta"),
    ).toThrow();
  });

  it("bounds all event timeframe declarations before native DOM measurement and rejects unsafe namespaces", () => {
    const size = admission();
    const getState = vi.fn(() => ({
      boxes: [{ text: "Task", r: 0, x: 0, y: 0, index: 0, dimension: { width: 80, height: 80 } }],
      swimlanes: { ui: { label: "UI", r: 0, y: 0, height: 80, maxHeight: 80, index: 0 } },
      relations: [],
    }));
    expect(size("eventmodeling", { getState }, "eventmodeling\ntf 01 ui Task")).toEqual([2, 0]);
    getState.mockClear();
    expect(() =>
      size(
        "eventmodeling",
        { getState },
        `eventmodeling\n${Array.from({ length: 251 }, (_, i) => `tf ${i} evt Event`).join("\n")}`,
      ),
    ).toThrow();
    expect(() =>
      size("eventmodeling", { getState }, "eventmodeling\ntf 01 ui __proto__.Task"),
    ).toThrow();
    expect(() =>
      size("eventmodeling", { getState }, `eventmodeling\ntf 01 ui Task${" ->> 01".repeat(251)}`),
    ).toThrow();
    expect(() =>
      size("eventmodeling", { getState }, "eventmodeling tf 01 ui Task ->> 99"),
    ).toThrow();
    expect(() =>
      size("eventmodeling", { getState }, "eventmodeling tf 01 ui Task ->> 02 tf 02 evt Event"),
    ).toThrow();
    expect(() =>
      size(
        "eventmodeling",
        { getState },
        `eventmodeling ${Array.from({ length: 251 }, (_, index) => `rf ${index} ui Task`).join(" ")}`,
      ),
    ).toThrow();
    expect(getState).not.toHaveBeenCalled();
    expect(
      size(
        "eventmodeling",
        { getState },
        "eventmodeling /* tf 02 evt Ignored */ rf /* comment */ 01 ui Task { payload: 'tf 03 evt Ignored' }",
      ),
    ).toEqual([2, 0]);
    expect(() =>
      size("eventmodeling", { getState }, "eventmodeling rf 01 ui Task tf 01 evt Duplicate"),
    ).toThrow();
    getState.mockClear();
    expect(() =>
      size("eventmodeling", { getState }, "eventmodeling tf 01 ui Task note 01 { note: text }"),
    ).toThrow();
    for (const payload of ['"quoted data"', "'quoted data'", "{loss}", "{ <b>html</b> }"])
      expect(() =>
        size("eventmodeling", { getState }, `eventmodeling tf 01 ui Task ${payload}`),
      ).toThrow();
    for (const declaration of [
      "tf 1000 evt Event",
      "rf missing ui Task",
      "note missing",
      "gwt missing",
    ])
      expect(() =>
        size("eventmodeling", { getState }, `eventmodeling tf 01 ui Task ${declaration}`),
      ).toThrow();
    expect(() =>
      size(
        "eventmodeling",
        { getState },
        "eventmodeling tf 01 ui Task gwt 01 given ui Task then ui Task",
      ),
    ).toThrow();
    expect(() =>
      size(
        "eventmodeling",
        { getState },
        "eventmodeling tf 01 ui Task\ndata Payload {\nfield: text\n}\n",
      ),
    ).toThrow();
    expect(getState).not.toHaveBeenCalled();
  });

  it("counts Venn's synthesized pairwise overlaps and bounds circles and numeric areas", () => {
    const size = admission();
    const subsets = [
      { sets: ["A"], size: 10 },
      { sets: ["B"], size: 10 },
      { sets: ["C"], size: 10 },
      { sets: ["A", "B", "C"], size: 1 },
    ];
    const db = { getSubsetData: () => subsets, getTextData: () => [], getStyleData: () => [] };
    expect(size("venn", db, "venn-beta")).toEqual([7, 6]);
    subsets[3]!.size = Infinity;
    expect(() => size("venn", db, "venn-beta")).toThrow();
    subsets[3]!.size = Number.MIN_VALUE;
    expect(() => size("venn", db, "venn-beta")).toThrow();
    subsets[3]!.size = 1e-7;
    expect(() => size("venn", db, "venn-beta")).toThrow();
    subsets[3]!.size = 1e-6;
    expect(size("venn", db, "venn-beta")).toEqual([7, 6]);
    expect(() =>
      size(
        "venn",
        {
          ...db,
          getSubsetData: () => Array.from({ length: 9 }, (_, i) => ({ sets: [`A${i}`], size: 1 })),
        },
        "venn-beta",
      ),
    ).toThrow();
  });

  it("counts every Ishikawa branch and rejects a shared/cyclic branch graph", () => {
    const size = admission();
    const child = { text: "Cause", children: [] };
    expect(
      size("ishikawa", { getRoot: () => ({ text: "Effect", children: [child] }) }, "ishikawa-beta"),
    ).toEqual([2, 1]);
    expect(() =>
      size(
        "ishikawa",
        { getRoot: () => ({ text: "Effect", children: [child, child] }) },
        "ishikawa-beta",
      ),
    ).toThrow();
  });

  it("binds Wardley references, coordinate domains, finite trends, sizes and aggregate decorations", () => {
    const size = admission();
    const data = wardley();
    expect(size("wardley", { getWardleyData: () => data }, "wardley-beta")).toEqual([1, 0]);
    data.nodes[0]!.x = NaN;
    expect(() => size("wardley", { getWardleyData: () => data }, "wardley-beta")).toThrow();
    data.nodes[0]!.x = 101;
    expect(() => size("wardley", { getWardleyData: () => data }, "wardley-beta")).toThrow();
    data.nodes[0]!.x = 50;
    expect(size("wardley", { getWardleyData: () => data }, "wardley-beta")).toEqual([1, 0]);
    expect(
      size(
        "wardley",
        {
          getWardleyData: () => ({
            ...data,
            trends: [{ nodeId: "app", targetX: 70, targetY: 80 }],
          }),
        },
        "wardley-beta",
      ),
    ).toEqual([1, 1]);
    expect(() =>
      size(
        "wardley",
        {
          getWardleyData: () => ({
            ...data,
            trends: [{ nodeId: "absent", targetX: 0.2, targetY: 0.3 }],
          }),
        },
        "wardley-beta",
      ),
    ).toThrow();
    expect(() =>
      size(
        "wardley",
        { getWardleyData: () => ({ ...data, size: { width: Infinity, height: 100 } }) },
        "wardley-beta",
      ),
    ).toThrow();
  });

  it("counts fixed Cynefin regions plus all items and validates exact domain names", () => {
    const size = admission();
    const domains = new Map([["clear", { name: "clear", items: [{ label: "Known solution" }] }]]);
    expect(
      size("cynefin", { getDomains: () => domains, getTransitions: () => [] }, "cynefin-beta"),
    ).toEqual([6, 0]);
    expect(() =>
      size(
        "cynefin",
        {
          getDomains: () => new Map([["unknown", { name: "unknown", items: [] }]]),
          getTransitions: () => [],
        },
        "cynefin-beta",
      ),
    ).toThrow();
  });

  it.each(["railroad", "railroadEbnf", "railroadAbnf", "railroadPeg"])(
    "qualifies %s's AST and keeps semantics lost by the native renderer source-only",
    (type) => {
      const size = admission();
      const terminal = { type: "terminal", value: "alpha" };
      const db = {
        getRules: () => [
          {
            name: "rule",
            definition: {
              type: "sequence",
              elements: [terminal, { type: "terminal", value: "beta" }],
            },
          },
        ],
      };
      expect(size(type, db, "railroad-beta")).toEqual([4, 2]);
      for (const node of [
        { type: "repetition", element: terminal, min: 0, max: 3 },
        { type: "repetition", element: terminal, min: 0, max: Infinity, separator: terminal },
        { type: "futureAstShape" },
      ]) {
        expect(() =>
          size(type, { getRules: () => [{ name: "rule", definition: node }] }, "railroad-beta"),
        ).toThrow();
      }
    },
  );

  it("binds info to the exact pinned engine, and never guesses an unknown family/DB", () => {
    const size = admission();
    expect(size("info", { getVersion: () => "12.0.0" }, "info")).toEqual([1, 0]);
    expect(() => size("info", { getVersion: () => "12.1.0" }, "info")).toThrow();
    expect(size("unknown", {}, "unknown")).toBeUndefined();
    expect(() => size("mindmap", {}, "mindmap")).toThrow();
  });
});
