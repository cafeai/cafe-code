import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import admissionSource from "./familyAdmission.js?raw";

interface AdmissionBoundary {
  cafeMermaidFamilyPreflight: (source: string) => void;
  cafeMermaidFamilySize: (type: string, db: object) => readonly [number, number] | undefined;
}

function admission(): AdmissionBoundary {
  // Execute the exact bundled script in a test-owned realm, never by importing
  // the production sandbox code into a renderer. Native data constructors are
  // injected only so synthetic records/Maps obey the same identity contract.
  const boundary = {} as AdmissionBoundary;
  new Script(admissionSource, { filename: "familyAdmission.js" }).runInNewContext(
    { globalThis: boundary, Object, Array, Map, Set, Number, Error },
    { timeout: 1000 },
  );
  return boundary;
}

const journeyTask = (people = ["User"]) => ({
  section: "Prepare",
  type: "Prepare",
  task: "Inspect",
  score: 5,
  people,
});
const journeyDb = (tasks = [journeyTask()]) => ({
  getTasks: () => tasks,
  getSections: () => ["Prepare"],
  getActors: () => ["User"],
});
const radarDb = (entries = [1, 2, 3], overrides: object = {}) => ({
  getAxes: () => ["a", "b", "c"].map((name) => ({ name, label: name })),
  getCurves: () => [{ name: "current", label: "Current", entries }],
  getOptions: () => ({
    min: 0,
    max: 10,
    ticks: 5,
    showLegend: true,
    graticule: "polygon",
    ...overrides,
  }),
});

describe("locked additional Mermaid family admission", () => {
  it("keeps unhandled families separate from malformed handled databases", () => {
    const boundary = admission();
    expect(boundary.cafeMermaidFamilySize("not-qualified", {})).toBeUndefined();
    expect(() => boundary.cafeMermaidFamilySize("journey", {})).toThrow();
  });

  it("counts journey actors and all task actor placements", () => {
    const { cafeMermaidFamilySize: size } = admission();
    expect(size("journey", journeyDb())).toEqual([3, 1]);
    expect(size("journey", journeyDb(Array.from({ length: 248 }, () => journeyTask())))).toEqual([
      250, 248,
    ]);
    expect(() =>
      size("journey", journeyDb(Array.from({ length: 249 }, () => journeyTask()))),
    ).toThrow();
    expect(() =>
      size("journey", journeyDb([journeyTask(Array.from({ length: 251 }, () => "User"))])),
    ).toThrow();
  });

  it.each([Infinity, NaN, -1, 6])("refuses unsafe journey score %s", (score) => {
    const task = { ...journeyTask(), score };
    expect(() => admission().cafeMermaidFamilySize("journey", journeyDb([task]))).toThrow();
  });

  it("refuses sparse task slots and missing actor identities", () => {
    expect(() => admission().cafeMermaidFamilySize("journey", journeyDb(new Array(1)))).toThrow();
    expect(() =>
      admission().cafeMermaidFamilySize("journey", journeyDb([journeyTask(["Other"])])),
    ).toThrow();
  });

  it("counts timeline task/section/event nodes including multiple events", () => {
    const make = (count: number) => ({
      getTasks: () =>
        Array.from({ length: count }, (_, id) => ({
          id,
          section: "Release",
          type: "Release",
          task: `Stage ${id}`,
          score: 0,
          events: ["Built", "Verified"],
        })),
      getSections: () => ["Release"],
    });
    expect(admission().cafeMermaidFamilySize("timeline", make(83))).toEqual([250, 166]);
    expect(() => admission().cafeMermaidFamilySize("timeline", make(84))).toThrow();
  });

  it("binds quadrant projection to fixed geometry and finite label positions", () => {
    const label = { text: "Label", x: 10, y: 10, fontSize: 12, rotation: 0 };
    const point = { x: 100, y: 100, radius: 5, text: label };
    const graph = {
      points: [point],
      quadrants: Array.from({ length: 4 }, () => ({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: label,
      })),
      axisLabels: [],
      borderLines: [],
    };
    const size = admission().cafeMermaidFamilySize;
    expect(size("quadrantChart", { getQuadrantData: () => graph })).toEqual([5, 0]);
    expect(() =>
      size("quadrantChart", {
        getQuadrantData: () => ({ ...graph, points: [{ ...point, x: 501 }] }),
      }),
    ).toThrow();
    expect(() =>
      size("quadrantChart", {
        getQuadrantData: () => ({ ...graph, points: [{ ...point, radius: Infinity }] }),
      }),
    ).toThrow();
    expect(() =>
      size("quadrantChart", { getQuadrantData: () => ({ ...graph, quadrants: [] }) }),
    ).toThrow();
  });

  it("counts exact requirement/element identities and refuses dangling relationships", () => {
    const requirement = {
      name: "r",
      type: "Requirement",
      requirementId: "R1",
      text: "Render safely",
      risk: "Low",
      verifyMethod: "Test",
      cssStyles: [],
      classes: ["default"],
    };
    const element = {
      name: "e",
      type: "renderer",
      docRef: "Synthetic specification",
      cssStyles: [],
      classes: ["default"],
    };
    const relation = { src: "e", dst: "r", type: "satisfies" };
    const db = {
      getRequirements: () => new Map([["r", requirement]]),
      getElements: () => new Map([["e", element]]),
      getRelationships: () => [relation],
      getClasses: () => new Map(),
    };
    expect(admission().cafeMermaidFamilySize("requirement", db)).toEqual([2, 1]);
    expect(() =>
      admission().cafeMermaidFamilySize("requirement", {
        ...db,
        getRelationships: () => [{ ...relation, dst: "absent" }],
      }),
    ).toThrow();
    expect(() =>
      admission().cafeMermaidFamilySize("requirement", {
        ...db,
        getRequirements: () => new Map([["r", { ...requirement, risk: "arbitrary" }]]),
      }),
    ).toThrow();
  });

  it("counts Git branches/tags and proves every parent precedes its exact commit", () => {
    const make = (count: number, withTag = false) => {
      const commits = Array.from({ length: count }, (_, seq) => ({
        id: `c${seq}`,
        seq,
        type: 0,
        branch: "main",
        message: "Synthetic",
        tags: withTag ? ["v1"] : [],
        parents: seq ? [`c${seq - 1}`] : [],
      }));
      return {
        getCommits: () => new Map(commits.map((commit) => [commit.id, commit])),
        getBranches: () => new Map([["main", commits.at(-1)?.id]]),
        getDirection: () => "LR",
        getOptions: () => ({}),
      };
    };
    expect(admission().cafeMermaidFamilySize("gitGraph", make(249))).toEqual([250, 248]);
    expect(() => admission().cafeMermaidFamilySize("gitGraph", make(250))).toThrow();
    expect(() => admission().cafeMermaidFamilySize("gitGraph", make(125, true))).toThrow();
    const db = make(2);
    const commits = db.getCommits();
    commits.get("c0")!.parents = ["c1"];
    expect(() =>
      admission().cafeMermaidFamilySize("gitGraph", { ...db, getCommits: () => commits }),
    ).toThrow();
  });

  it("counts every flat block entry and binds rendered hierarchy to those exact objects", () => {
    const child = { id: "child", type: "square", label: "Child", widthInColumns: 1 };
    const root = { id: "root", type: "composite", children: [child], columns: -1 };
    const flat = new Map<string, object>([
      ["root", root],
      ["child", child],
    ]);
    const db = {
      getBlocksFlat: () => [...flat.values()],
      getBlocks: () => [child],
      getEdges: () => [],
      getBlock: (id: string) => flat.get(id),
      getClasses: () => new Map(),
    };
    expect(admission().cafeMermaidFamilySize("block", db)).toEqual([2, 0]);
    expect(() =>
      admission().cafeMermaidFamilySize("block", { ...db, getBlocks: () => [{ ...child }] }),
    ).toThrow();
    expect(() =>
      admission().cafeMermaidFamilySize("block", { ...db, getBlocks: () => [child, child] }),
    ).toThrow();
    expect(() =>
      admission().cafeMermaidFamilySize("block", {
        ...db,
        getEdges: () => [{ type: "edge", start: "child", end: "missing", label: "" }],
      }),
    ).toThrow();
  });

  it("counts radar axes, curves, ticks and every retained curve entry", () => {
    expect(admission().cafeMermaidFamilySize("radar", radarDb())).toEqual([9, 3]);
    expect(
      admission().cafeMermaidFamilySize("radar", radarDb([1, 2, 3], { max: undefined })),
    ).toEqual([9, 3]);
    expect(() => admission().cafeMermaidFamilySize("radar", radarDb([1, 2]))).toThrow();
    expect(() => admission().cafeMermaidFamilySize("radar", radarDb([1, 2, Infinity]))).toThrow();
  });

  it.each([
    { min: 2, max: 2 },
    { min: -1e308, max: 1e308 },
    { min: 0, max: 1e308 },
    { min: 0, max: Number.MIN_VALUE },
    { ticks: 0 },
    { ticks: 251 },
    { ticks: 2.5 },
    { graticule: "unknown" },
  ])("refuses invalid radar domain/tick contracts %j", (options) => {
    expect(() => admission().cafeMermaidFamilySize("radar", radarDb([1, 2, 3], options))).toThrow();
  });

  it("binds Sankey links to exact nodes and rejects cycles before layout", () => {
    const a = { ID: "A" };
    const b = { ID: "B" };
    const make = (links: object[]) => ({ getNodes: () => [a, b], getLinks: () => links });
    const size = admission().cafeMermaidFamilySize;
    expect(size("sankey", make([{ source: a, target: b, value: 2 }]))).toEqual([2, 1]);
    expect(() => size("sankey", make([{ source: { ID: "A" }, target: b, value: 2 }]))).toThrow();
    expect(() =>
      size(
        "sankey",
        make([
          { source: a, target: b, value: 2 },
          { source: b, target: a, value: 2 },
        ]),
      ),
    ).toThrow();
    expect(size("sankey", make([{ source: a, target: b, value: 1e300 }]))).toEqual([2, 1]);
    for (const value of [0, -1, NaN, Infinity, Number.MIN_VALUE, 1e308])
      expect(() => size("sankey", make([{ source: a, target: b, value }]))).toThrow();
  });

  it("binds packet fragments to contiguous native rows", () => {
    const row = [
      { start: 0, end: 7, bits: 8, label: "Version" },
      { start: 8, end: 15, bits: 8, label: "Flags" },
    ];
    expect(admission().cafeMermaidFamilySize("packet", { getPacket: () => [row] })).toEqual([3, 2]);
    expect(() =>
      admission().cafeMermaidFamilySize("packet", { getPacket: () => [[{ ...row[0], bits: 7 }]] }),
    ).toThrow();
    expect(() =>
      admission().cafeMermaidFamilySize("packet", { getPacket: () => [[{ ...row[0], start: 1 }]] }),
    ).toThrow();
  });

  it("walks exact treemap identities once and refuses aliased/cyclic/value-invalid trees", () => {
    const leaf = { name: "Leaf", value: 1 };
    const root = { name: "Root", children: [leaf] };
    const db = { getNodes: () => [root, leaf], getRoot: () => root, getClasses: () => new Map() };
    expect(admission().cafeMermaidFamilySize("treemap", db)).toEqual([2, 1]);
    expect(() =>
      admission().cafeMermaidFamilySize("treemap", { ...db, getRoot: () => ({ ...root }) }),
    ).toThrow();
    for (const value of [0, -1, Infinity, NaN, Number.MIN_VALUE, 1e308, 1e-200]) {
      const bad = { name: "Leaf", value };
      expect(() =>
        admission().cafeMermaidFamilySize("treemap", {
          getNodes: () => [bad],
          getRoot: () => bad,
          getClasses: () => new Map(),
        }),
      ).toThrow();
    }
    const alias = { name: "Root", children: [leaf, leaf] };
    expect(() =>
      admission().cafeMermaidFamilySize("treemap", {
        ...db,
        getNodes: () => [alias, leaf],
        getRoot: () => alias,
      }),
    ).toThrow();
  });

  it("refuses treemap squared-weight underflow across vastly different leaf scales", () => {
    const leaves = [
      { name: "Small", value: 1e-150 },
      { name: "Large", value: 1e150 },
    ];
    const db = {
      getNodes: () => leaves,
      getRoot: () => ({ name: "", children: leaves }),
      getClasses: () => new Map(),
    };
    expect(() => admission().cafeMermaidFamilySize("treemap", db)).toThrow();
    const one = [leaves[1]];
    expect(
      admission().cafeMermaidFamilySize("treemap", {
        ...db,
        getNodes: () => one,
        getRoot: () => ({ name: "", children: one }),
      }),
    ).toEqual([2, 1]);
  });

  it("counts the native treemap synthetic hierarchy parent and every child link", () => {
    const make = (count: number) => {
      const leaves = Array.from({ length: count }, (_, i) => ({ name: `Leaf ${i}`, value: 1 }));
      return {
        getNodes: () => leaves,
        getRoot: () => ({ name: "", children: leaves }),
        getClasses: () => new Map(),
      };
    };
    expect(admission().cafeMermaidFamilySize("treemap", make(2))).toEqual([3, 2]);
    expect(admission().cafeMermaidFamilySize("treemap", make(249))).toEqual([250, 249]);
    expect(() => admission().cafeMermaidFamilySize("treemap", make(250))).toThrow();
  });

  it("accepts authored Kanban indentation columns without inventing normalized depth", () => {
    // Both native group and card witnesses share this test-only shape. Keep
    // optional card metadata explicit so malformed parent evidence is checked
    // by admission rather than hidden by default-array type inference.
    type KanbanNode = {
      id: string;
      label: string;
      isGroup: boolean;
      shape: string;
      level: number;
      parentId?: string;
      cssStyles?: string[];
    };
    const section = {
      id: "backlog",
      label: "Backlog",
      isGroup: true,
      shape: "kanbanSection",
      level: 4,
    };
    const card = {
      id: "card",
      label: "Inspect",
      isGroup: false,
      shape: "kanbanItem",
      level: 8,
      parentId: "backlog",
      cssStyles: ["text-align: left"],
    };
    const make = (nodes: KanbanNode[] = [section, card]) => ({
      getData: () => ({ nodes, edges: [] }),
      getSections: () => [{ id: "backlog" }],
    });
    expect(admission().cafeMermaidFamilySize("kanban", make())).toEqual([2, 0]);
    expect(() =>
      admission().cafeMermaidFamilySize(
        "kanban",
        make([section, { ...card, parentId: "missing" }]),
      ),
    ).toThrow();
  });
});

describe("pre-parser allocation admission", () => {
  it("counts aggregate expanded block spacers before native setHierarchy", () => {
    const preflight = admission().cafeMermaidFamilyPreflight;
    expect(() => preflight("block-beta\ncolumns 3\nspace:3")).not.toThrow();
    expect(() => preflight("block-beta\nspace:125\nspace:125")).not.toThrow();
    expect(() => preflight("block-beta\nspace:125\nspace:126")).toThrow();
    expect(() => preflight("block-beta\nspace:1000000000")).toThrow();
    expect(() => preflight("block-beta\ncolumns 1000000000")).toThrow();
  });

  it("mirrors contiguous native packet subdivision without row allocation", () => {
    const preflight = admission().cafeMermaidFamilyPreflight;
    expect(() => preflight('packet\n+4000: "Payload"')).not.toThrow();
    expect(() => preflight('packet\n+4001: "Payload"')).toThrow();
    expect(() => preflight('packet-beta\n0-3999: "Payload"')).not.toThrow();
    expect(() => preflight('packet\n+8000: "Payload"')).toThrow();
    expect(() => preflight('packet\n+1000000000: "Payload"')).toThrow();
    expect(() => preflight('packet-beta\n0-7: "One"\n9-15: "Gap"')).toThrow();
  });

  it("counts same-line Packet header fields before any native row population", () => {
    const preflight = admission().cafeMermaidFamilyPreflight;
    // These are bounded syntax witnesses only: no huge source is submitted to
    // Mermaid. Its pinned grammar permits a first PacketBlock immediately
    // after the header, followed by EOL after that block's quoted label.
    expect(() => preflight('packet +8: "Type"\n+8: "Flags"')).not.toThrow();
    expect(() => preflight('packet-beta 0-7: "Type"\n8-15: "Flags"')).not.toThrow();
    expect(() => preflight('%% Intro\n  packet +4000: "Payload"')).not.toThrow();
    expect(() => preflight('packet-beta 0-3999: "Payload"')).not.toThrow();
    for (const source of [
      'packet +4001: "Payload"',
      'packet +1000000000: "Payload"',
      'packet-beta +1000000000: "Payload"',
      'packet 0-1000000000: "Payload"',
      'packet-beta 1000000000: "Payload"',
      'packet 0-7: "One"\n9-15: "Gap"',
    ])
      expect(() => preflight(source)).toThrow();
  });

  it("bounds repeated journey/timeline compilation declarations before their resolving getter", () => {
    for (const family of ["journey", "timeline"]) {
      const source = `${family}\n${Array.from({ length: 250 }, () => "Entry : 1 : User").join("\n")}`;
      expect(() => admission().cafeMermaidFamilyPreflight(source)).toThrow();
    }
  });
});
