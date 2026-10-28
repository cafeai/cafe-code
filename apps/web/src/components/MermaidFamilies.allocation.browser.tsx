import "../index.css";
import { describe, expect, it } from "vitest";
import { installMermaidFamilyCleanup } from "./mermaidFamilyCleanup.test.fixture";
import { MERMAID_FAMILY_FIXTURES } from "./mermaidFamilies.test.fixture";
import { ownedParsedFamilyProbe } from "./mermaidFamilyProbe.test.fixture";
import { admitMermaidSource } from "../lib/mermaid/policy";

installMermaidFamilyCleanup();

describe("new family pre-layout security admission", () => {
  // Exhaustive source/header combinations exercise the exact receiver in
  // runtimeSourceAdmission.test.ts. Keep native one-use frame proof here for
  // all three refusal classes; source-only refusal precedes family parsing.
  it("refuses source configuration and callbacks before native parsing at both boundaries", async ({
    signal,
  }) => {
    const probe = ownedParsedFamilyProbe(signal);
    const fixture = MERMAID_FAMILY_FIXTURES.find(
      (entry) => entry.family === "packet relative lengths",
    );
    expect(fixture).toBeDefined();
    const source = fixture!.source;
    for (const hostile of [
      `%%{init: {"securityLevel":"loose"}}%%\n${source}`,
      `${source}\nclick target "https://example.invalid/diagram"`,
      `---\nconfig:\n  securityLevel: loose\n---\n${source}`,
    ]) {
      expect(() => admitMermaidSource(hostile)).toThrow();
      expect(await probe(hostile, "", undefined, undefined, 0)).toBe(false);
    }
  });

  it.for([
    {
      name: "same-line reset-frame declarations",
      source: `eventmodeling ${Array.from({ length: 251 }, (_, index) => `rf ${index} ui Task`).join(" ")}`,
    },
    {
      name: "same-line repeated dependencies",
      source: `eventmodeling tf 01 ui Task${" ->> 01".repeat(251)}`,
    },
    {
      name: "unresolved native dependency identities",
      source: "eventmodeling tf 01 ui Task ->> 99",
    },
    {
      name: "forward native dependencies omitted by one-pass resolution",
      source: "eventmodeling tf 01 ui Task ->> 02 tf 02 cmd Done",
    },
  ])(
    "refuses $name before the allocating native event-state resolver",
    async ({ source }, { signal }) => {
      const probe = ownedParsedFamilyProbe(signal);
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "eventmodeling")!;
      const mutation = `const native = diagram.db.getState.bind(diagram.db);
      diagram.db.getState = () => { probeNativeStateCalls++; return native(); };`;
      // The real parser receives a known-safe same-family fixture so allocation
      // cannot hide a missing raw token fence. Production still receives the
      // exact hostile source as its admission input; no source is rewritten by
      // the application. The method-replacement proof must be active and the
      // resolver count must remain exactly zero when the guard refuses.
      expect(await probe(fixture.source, mutation, fixture.source)).toBe(true);
      expect(await probe(source, mutation, fixture.source, 0)).toBe(false);
    },
  );

  it("admits an exact native event inline payload with retained trailing whitespace", async ({
    signal,
  }) => {
    const probe = ownedParsedFamilyProbe(signal);
    expect(await probe("eventmodeling\ntf 01 ui Task { title: string }")).toBe(true);
  });

  it.for([
    ["an inline brace payload whose final character would be lost", "{title:string}"],
    ["double-quoted data the native renderer treats as braces", '"quoted data"'],
    ["single-quoted data the native renderer treats as braces", "'quoted data'"],
    ["unqualified inline markup", "{ <b>html</b> }"],
  ] as const)(
    "refuses %s before native event-state allocation",
    async ([_name, payload], { signal }) => {
      const probe = ownedParsedFamilyProbe(signal);
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "eventmodeling")!;
      const mutation = `const native = diagram.db.getState.bind(diagram.db);
      diagram.db.getState = () => { probeNativeStateCalls++; return native(); };`;
      expect(await probe(fixture.source, mutation, fixture.source)).toBe(true);
      expect(
        await probe(`eventmodeling\ntf 01 ui Task ${payload}`, mutation, fixture.source, 0),
      ).toBe(false);
    },
  );

  it.for([
    ["journey outside native score rail", "journey\nCompile: 6: User"],
    ["journey prototype actor", "journey\nCompile: 5: __proto__"],
    ["sankey directed cycle", "sankey-beta\n\nA,B,1\nB,A,1"],
    ["sankey self loop", "sankey-beta\n\nA,A,1"],
    ["sankey zero flow", "sankey-beta\n\nA,B,0"],
    ["sankey negative flow", "sankey-beta\n\nA,B,-1"],
    ["sankey overflowed flow", "sankey-beta\n\nA,B,1e309"],
    ["block allocating unbounded spacer", "block-beta\nspace:1000000000"],
    ["block unbounded columns", "block-beta\ncolumns 1000000000\nA[Item]"],
    ["block unbounded span", "block-beta\nA[Item]:1000000000"],
    [
      "block external style resource",
      'block-beta\nA[Item]\nstyle A fill:url("https://example.invalid/paint")',
    ],
    ["packet allocating unbounded bit rows", 'packet\n+1000000000: "Huge field"'],
    ["packet noncontiguous fields", 'packet\n0-7: "First"\n16-31: "Skipped"'],
    ["packet zero length", 'packet\n+0: "Empty"'],
    ["packet reversed field", 'packet\n0-7: "First"\n8-3: "Reversed"'],
    [
      "radar singular scale",
      'radar-beta\naxis a["A"], b["B"], c["C"]\ncurve one["One"]{1,1,1}\nmin 1\nmax 1',
    ],
    [
      "radar mismatched entries",
      'radar-beta\naxis a["A"], b["B"], c["C"]\ncurve one["One"]{1,2}\nmax 3',
    ],
    ["treemap zero-valued leaf", 'treemap-beta\n"Root"\n "Empty": 0'],
    ["treemap subnormal layout scale", 'treemap-beta\n"Root"\n "Tiny": 1e-320'],
    ["treemap overflowed total", 'treemap-beta\n"Root"\n "First": 1e308\n "Second": 1e308'],
    [
      "radar overflowing domain",
      'radar-beta\naxis a["A"], b["B"], c["C"]\ncurve one["One"]{1,2,3}\nmin -1e308\nmax 1e308',
    ],
    [
      "architecture custom icon acquisition",
      "architecture-beta\nservice app(external:server)[Application]",
    ],
    ["eventmodeling prototype identity", "eventmodeling\ntf 01 ui __proto__"],
    ["Wardley out-of-domain coordinate", "wardley-beta\ncomponent Node [101, 50]"],
    [
      "Wardley extreme native drawing size",
      "wardley-beta\ncomponent Node [0.5, 0.5]\nsize [1000000000,1000000000]",
    ],
    ["railroad semantically lost finite repetition", 'railroad-abnf-beta\nrule = 3"alpha" ;'],
  ] as const)("refuses unsafe %s before final layout", async ([_name, source], { signal }) => {
    const probe = ownedParsedFamilyProbe(signal);
    expect(await probe(source)).toBe(false);
  });

  it.for([
    ["packet relative lengths", 'packet\n+1000000000: "Huge field"'],
    ["packet-beta absolute offsets", 'packet-beta\n0-1000000000: "Huge field"'],
    ["block-beta", "block-beta\nspace:1000000000"],
    ["block-beta", "block-beta\ncolumns 1000000000\nA[Item]"],
    ["block-beta", "block-beta\nA[Item]:1000000000"],
    ["block-beta", "block-beta\nspace:250\nspace:250"],
  ] as const)(
    "refuses allocating %s syntax before entering even a safe parser substitute",
    async ([family, source], { signal }) => {
      const probe = ownedParsedFamilyProbe(signal);
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
      // The fixed test-only parser substitute returns the real, known valid
      // database for this SAME family. Its final layout is still a sentinel. If
      // unsafe source were only rejected by post-parse graph counts, substituting
      // this bounded graph would admit it. Refusal proves raw preflight ran before
      // the parser's spacer/bit-row allocation. Production never substitutes DSL.
      expect(await probe(fixture.source, "", fixture.source)).toBe(true);
      expect(await probe(source, "", fixture.source)).toBe(false);
    },
  );

  it.for(
    (["packet", "packet-beta"] as const).flatMap((header) =>
      (["relative", "absolute"] as const).flatMap((syntax) =>
        (["first-header-line", "later-line"] as const).map((position) => ({
          header,
          syntax,
          position,
        })),
      ),
    ),
  )(
    "refuses huge $header $syntax $position fields before native parser entry",
    async ({ header, syntax, position }, { signal }) => {
      const probe = ownedParsedFamilyProbe(signal);
      const fixture = MERMAID_FAMILY_FIXTURES.find(
        (entry) => entry.family === "packet relative lengths",
      )!;
      const prefix =
        position === "later-line"
          ? syntax === "relative"
            ? '+8: "First"\n'
            : '0-7: "First"\n'
          : "";
      const huge =
        syntax === "relative"
          ? '+1000000000: "Huge field"'
          : `${position === "later-line" ? 8 : 0}-1000000000: "Huge field"`;
      // Only the tiny known-safe packet fixture could reach the real parser.
      // The substitute identity is independently proven installed, its safe
      // control must enter exactly once, and each hostile header/later-line source
      // must be refused with exactly zero native parser calls. Never pass the
      // enormous field to Mermaid to discover the parser's allocation bound.
      expect(await probe(fixture.source, "", fixture.source, undefined, 1)).toBe(true);
      expect(await probe(`${header} ${prefix}${huge}`, "", fixture.source, undefined, 0)).toBe(
        false,
      );
    },
  );
});
