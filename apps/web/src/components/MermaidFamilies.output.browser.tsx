import "../index.css";
import { describe, expect, it } from "vitest";
import { installMermaidFamilyCleanup } from "./mermaidFamilyCleanup.test.fixture";
import { renderNativeFamilyOutput } from "./mermaidFamilyProbe.test.fixture";
import { decodeSvg, parsedSvg, textLabels } from "./mermaidFamilyRendering.test.fixture";

installMermaidFamilyCleanup();

describe("new family pre-layout security admission", () => {
  it("preserves all native event labels and inline data as inert SVG text", async ({ signal }) => {
    const svg = await renderNativeFamilyOutput("eventmodeling", "", signal);
    expect(svg).not.toBeNull();
    const parsed = parsedSvg(svg!);
    expect(parsed.querySelectorAll("g.em-box")).toHaveLength(4);
    expect(parsed.querySelectorAll("g.em-box > text")).toHaveLength(4);
    for (const label of ["TaskForm", "CreateTask", "TaskCreated", "TaskList"])
      expect(textLabels(parsed)).toContain(label);
    const dataLines = Array.from(parsed.querySelectorAll("g.em-box tspan"))
      .map((span) => (span.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((line) => line === "title: string");
    expect(dataLines).toHaveLength(2);
    await decodeSvg(svg!);
  });

  it.for([
    ["resource-bearing HTML", "bold.append(document.createElement('img'));"],
    ["interactive HTML", "bold.append(document.createElement('a'));"],
    ["script HTML", "bold.append(document.createElement('script'));"],
    ["nested arbitrary formatting", "bold.append(document.createElement('i'));"],
    ["HTML comments", "bold.append(document.createComment('private-synthetic-label'));"],
    ["HTML event handlers", "bold.setAttribute('onclick', 'private-synthetic-label');"],
    ["HTML links", "bold.setAttribute('href', 'https://example.invalid/synthetic');"],
    [
      "unqualified native wrapper style",
      "foreignObject.querySelector('span').style.color = 'red';",
    ],
    ["unqualified inline data style", "code.style.maxWidth = '100000px';"],
    ["unknown foreign-object attributes", "foreignObject.setAttribute('class', 'unexpected');"],
    ["non-finite box geometry", "foreignObject.setAttribute('width', 'Infinity');"],
    ["non-finite native viewport", "svg.setAttribute('viewBox', '0 0 Infinity 100');"],
    ["non-decimal native viewport", "svg.setAttribute('viewBox', '0 0 0x100 100');"],
    [
      "non-finite native relation geometry",
      "svg.querySelector('path.em-relation').setAttribute('d', 'M0 0 LNaN 100');",
    ],
    [
      "overflowing native rectangle coordinates",
      "foreignObject.parentNode.querySelector('rect').setAttribute('x', '1e308');",
    ],
    ["zero box geometry", "foreignObject.setAttribute('height', '0');"],
    [
      "mismatched native box coordinates",
      "foreignObject.setAttribute('x', String(Number(foreignObject.getAttribute('x')) + 1));",
    ],
    [
      "mismatched native rectangle geometry",
      "foreignObject.parentNode.querySelector('rect').setAttribute('width', '99999');",
    ],
    [
      "unknown native rounding",
      "foreignObject.parentNode.querySelector('rect').setAttribute('rx', '4');",
    ],
    [
      "unqualified foreign-object parent",
      "foreignObject.parentNode.setAttribute('class', 'ordinary-html-box');",
    ],
    [
      "unexpected native box siblings",
      "foreignObject.parentNode.append(document.createElementNS('http://www.w3.org/2000/svg', 'text'));",
    ],
    ["HTML outside native foreign objects", "svg.append(document.createElement('div'));"],
    [
      "unqualified label line count",
      "bold.replaceChildren(...Array.from({ length: 251 }, () => document.createElement('br')));",
    ],
    ["unreadably overwide labels", "bold.textContent = 'W'.repeat(1000);"],
  ] as const)(
    "refuses %s without widening event HTML or SVG admission",
    async ([_name, mutation], { signal }) => {
      expect(await renderNativeFamilyOutput("eventmodeling", mutation, signal)).toBeNull();
    },
  );

  it("binds only the exact pinned native info label to its fixed viewport", async ({ signal }) => {
    const svg = await renderNativeFamilyOutput("info", "", signal);
    expect(svg).not.toBeNull();
    const parsed = parsedSvg(svg!);
    expect(parsed.documentElement.getAttribute("viewBox")).toBe("0 0 400 100");
    expect(parsed.querySelectorAll("text")).toHaveLength(1);
    expect(parsed.querySelector("text")?.textContent).toBe("v12.0.0");
    await decodeSvg(svg!);
  });

  it.for([
    ["a source-shaped viewport", "svg.setAttribute('viewBox', '0 0 99999 99999');"],
    ["a future version label", "svg.querySelector('text').textContent = 'v13.0.0';"],
    ["a foreign fixed width", "svg.style.maxWidth = '500px';"],
    ["a foreign namespace", "svg.setAttribute('xmlns', 'urn:unqualified');"],
    ["extra HTML", "svg.append(document.createElement('div'));"],
    [
      "extra SVG drawings",
      "svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'circle'));",
    ],
    [
      "nested version markup",
      "svg.querySelector('text').append(document.createElementNS('http://www.w3.org/2000/svg', 'tspan'));",
    ],
    [
      "version event handlers",
      "svg.querySelector('text').setAttribute('onclick', 'private-synthetic-label');",
    ],
    ["a changed native label origin", "svg.querySelector('text').setAttribute('x', '101');"],
    [
      "non-finite version font geometry",
      "svg.querySelector('text').setAttribute('font-size', 'NaN');",
    ],
    [
      "extra native container text",
      "svg.querySelector('g').append(document.createTextNode('private-synthetic-label'));",
    ],
    [
      "unqualified version links",
      "svg.querySelector('text').setAttribute('href', 'https://example.invalid/synthetic');",
    ],
  ] as const)(
    "refuses %s instead of inventing a generic info viewport",
    async ([_name, mutation], { signal }) => {
      expect(await renderNativeFamilyOutput("info", mutation, signal)).toBeNull();
    },
  );
});
