import { afterEach, describe, expect, it } from "vitest";

import { admitMermaidSource, MERMAID_FAILURE, MAX_MERMAID_SVG_BYTES } from "../lib/mermaid/policy";
import { createMermaidSandboxDocument } from "../lib/mermaid/sandboxDocument";
import { sanitizeMermaidSvg } from "../lib/mermaid/sanitizeSvg";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgDocument(contents: string, attributes = ""): string {
  return `<svg xmlns="${SVG_NAMESPACE}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 60" ${attributes}>${contents}</svg>`;
}

async function admitsParsedGraph(source: string): Promise<boolean> {
  const nonce = crypto.randomUUID();
  const id = crypto.randomUUID();
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  frame.dataset.mermaidSecurityFixture = "";
  frame.setAttribute("sandbox", "allow-scripts");
  // Execute the real pinned parser and production admission code. Replacing
  // only the final layout call gives a direct admission signal without asking
  // every boundary fixture to perform an expensive 250-node graph layout.
  const admittedSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />';
  const instrumentedDocument = createMermaidSandboxDocument(nonce).replace(
    "</script></body>",
    `</script><script nonce="${nonce}">mermaid.render = async () => ({ svg: ${JSON.stringify(admittedSvg)} });</script></body>`,
  );
  return new Promise((resolve, reject) => {
    const finish = (admitted: boolean | undefined) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      if (admitted === undefined) reject(new Error("Graph admission probe did not reply"));
      else resolve(admitted);
    };
    const timeout = setTimeout(() => finish(undefined), 10_000);
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== "object" || !("id" in data) || data.id !== id) return;
      finish("svg" in data && data.svg === admittedSvg);
    };
    frame.onload = () => {
      frame.onload = null;
      frame.contentWindow?.postMessage("cafe-mermaid-render", "*", [channel.port2]);
      channel.port1.postMessage({ id, source, theme: "dark" });
    };
    frame.srcdoc = instrumentedDocument;
    document.body.append(frame);
  });
}

afterEach(() => {
  for (const frame of document.querySelectorAll("iframe[data-mermaid-security-fixture]")) {
    frame.remove();
  }
});

describe("Mermaid SVG security boundary", () => {
  it("removes active content, external references, and event handlers before image creation", () => {
    const result = sanitizeMermaidSvg(
      svgDocument(
        `<title>Safe title</title><desc>Safe description</desc>
        <script>window.__mermaidExecuted = true</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://example.invalid/tracker" onerror="alert(1)" /></div></foreignObject>
        <image href="https://example.invalid/image" width="10" height="10" />
        <use xlink:href="https://example.invalid/remote.svg#x" />
        <a href="javascript:alert(1)"><text x="5" y="10">Plain label</text></a>
        <animate attributeName="href" values="javascript:alert(1)" />
        <set attributeName="onload" to="alert(1)" />
        <rect width="30" height="20" onclick="alert(1)" onload="alert(1)" data-secret="x" />`,
        'onload="alert(1)" xml:base="https://example.invalid/"',
      ),
    );
    const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    expect(
      parsed.querySelector("script,foreignObject,image,use,a,animate,set,iframe,img"),
    ).toBeNull();
    for (const element of parsed.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name).not.toMatch(/^(?:on|href$|xlink:|xml:base$|data-)/i);
      }
    }
    expect(result.svg).not.toContain("example.invalid");
    expect(result.svg).not.toContain("javascript:");
    expect(result.title).toBe("Safe title. Safe description");
    expect(result.width).toBe(100);
    expect(result.height).toBe(60);
  });

  it.each([
    '.node { fill: url("https://example.invalid/tracker"); }',
    '.node { fill: url("data:image/svg+xml,evil"); }',
    '.node { fill: u\\72l("https://example.invalid/tracker"); }',
    '.node { fill: u/**/rl("https://example.invalid/tracker"); }',
    '@import "https://example.invalid/style";',
    '.node { background-image: image-set("https://example.invalid/tracker" 1x); }',
    ".node { width: expression(alert(1)); }",
  ])("rejects resource-bearing or disguised generated CSS %s", (css) => {
    expect(() => sanitizeMermaidSvg(svgDocument(`<style>${css}</style><rect />`))).toThrow(
      MERMAID_FAILURE,
    );
  });

  it("rejects hostile presentation attributes and preserves same-image marker references", () => {
    expect(() =>
      sanitizeMermaidSvg(
        svgDocument('<path d="M0 0 L1 1" fill="url(https://example.invalid/x)" />'),
      ),
    ).toThrow(MERMAID_FAILURE);

    const result = sanitizeMermaidSvg(
      svgDocument(
        '<defs><marker id="arrow" viewBox="0 0 10 10"><path d="M0 0 L10 5 L0 10 Z" /></marker></defs><style>.edge { marker-end: url(#arrow); }</style><path class="edge" d="M0 0 L30 30" marker-end="url(#arrow)" />',
      ),
    );
    expect(result.svg).toContain("url(#arrow)");
    expect(result.svg).toContain('id="arrow"');
  });

  it("removes expensive CSS, animation rules, and nested rule declarations", () => {
    const result = sanitizeMermaidSvg(
      svgDocument(
        `<style>
          @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
          .node {
            fill: red; stroke-width: 2px;
            animation: pulse 1ms infinite;
            transition: all 1ms;
            filter: blur(10000px);
            transform: scale(100000);
            width: 100000px;
            --private-custom: 99999;
            .nested { filter: blur(10000px); animation: pulse 1ms infinite; }
          }
        </style>
        <rect class="node" width="10" height="10" style="fill: blue; filter: blur(10000px); animation: pulse 1ms infinite; transform: scale(100000); position: fixed; --private-custom: 99999" />`,
      ),
    );
    const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    const css = parsed.querySelector("style")?.textContent ?? "";
    const inline = parsed.querySelector("rect")?.getAttribute("style") ?? "";
    expect(css).toContain("fill: red");
    expect(css).toContain("stroke-width: 2px");
    expect(inline).toContain("fill: blue");
    for (const value of [css, inline]) {
      expect(value).not.toMatch(
        /keyframes|animation|transition|filter|transform|position|--private-custom|100000|\.nested/,
      );
    }
  });

  it("rejects entities, invalid roots, unbounded dimensions, and oversized UTF-8 output", () => {
    const rejected = [
      '<!DOCTYPE svg [<!ENTITY x "payload">]><svg viewBox="0 0 10 10"><text>&x;</text></svg>',
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>not SVG</body></html>',
      `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 NaN 10" />`,
      `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 100001 10" />`,
      `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 0 10" />`,
      svgDocument(`<text>${"界".repeat(Math.floor(MAX_MERMAID_SVG_BYTES / 3))}</text>`),
    ];
    for (const candidate of rejected) {
      expect(() => sanitizeMermaidSvg(candidate)).toThrow(MERMAID_FAILURE);
    }
  });
});

describe("Mermaid source and parsed-graph admission", () => {
  it.each([
    '%%{init: {"securityLevel":"loose"}}%%\ngraph TD\nA-->B',
    "---\nconfig:\n  securityLevel: loose\n---\ngraph TD\nA-->B",
    'graph TD\nA-->B\nclick A "https://example.invalid/"',
    "graph TD; A-->B; click A callback",
    "sequenceDiagram\nparticipant A\nlink A: Website @ https://example.invalid/",
    'sequenceDiagram\nparticipant A\nlinks A: {"Website":"https://example.invalid/"}',
    'graph TD\nA@{ img: "https://example.invalid/image" }',
    'graph TD\nA@{ "img": "https://example.invalid/image" }',
    "graph TD\nA@{ 'img': 'https://example.invalid/image' }",
  ])(
    "rejects interactive, image, or configuration syntax at both boundaries %s",
    async (source) => {
      expect(() => admitMermaidSource(source)).toThrow(MERMAID_FAILURE);
      expect(await admitsParsedGraph(source)).toBe(false);
    },
  );

  it("preserves ordinary labels containing words used by forbidden commands", async () => {
    const source = 'graph TD\nA["click, links, and img are text"]-->B';
    expect(() => admitMermaidSource(source)).not.toThrow();
    expect(await admitsParsedGraph(source)).toBe(true);
  });

  it("rejects canonical image nodes even when YAML encodes the img property name", async () => {
    expect(
      await admitsParsedGraph('graph TD\nA@{ "i\\u006dg": "https://example.invalid/image" }'),
    ).toBe(false);
    expect(await admitsParsedGraph("graph TD\nA@{ shape: imageSquare }")).toBe(false);
  });

  it("handles bounded repeated malformed config openers without weakening image admission", async () => {
    const malformed = `graph TD\n${"@{".repeat(15_000)}`;
    // Keep this near-limit adversarial input in the ordinary functional suite.
    // Timing is deliberately not asserted: CI load must not turn a security
    // fixture into a flaky benchmark. The source scan defers malformed grammar
    // to the isolated parser, which rejects it before the layout sentinel runs.
    expect(() => admitMermaidSource(malformed)).not.toThrow();
    expect(await admitsParsedGraph(malformed)).toBe(false);

    const withImage = `${malformed} "img": "https://example.invalid/image" }`;
    expect(() => admitMermaidSource(withImage)).toThrow(MERMAID_FAILURE);
    expect(await admitsParsedGraph(withImage)).toBe(false);
  });

  it.each([
    [
      "flowchart subgraph containers",
      (count: number) =>
        `flowchart TD\n${Array.from({ length: count }, (_, i) => `subgraph G${i}\nN${i}\nend`).join("\n")}`,
      125,
      126,
    ],
    [
      "nested class namespaces",
      (count: number) =>
        `classDiagram\nnamespace Outer {\nnamespace Inner {\n${Array.from({ length: count }, (_, i) => `class C${i}`).join("\n")}\n}\n}`,
      248,
      249,
    ],
    [
      "class lollipop interface nodes",
      (count: number) =>
        `classDiagram\n${Array.from({ length: count }, (_, i) => `A --() I${i}`).join("\n")}`,
      249,
      250,
    ],
    [
      "class note attachment edges",
      (count: number) =>
        `classDiagram\n${Array.from({ length: count }, () => "A -- B").join("\n")}\nnote for A "Attached note"`,
      249,
      250,
    ],
    [
      "nested state containers",
      (count: number) =>
        `stateDiagram-v2\nstate Outer {\nstate Inner {\n${Array.from({ length: count }, (_, i) => `S${i}`).join("\n")}\n}\n}`,
      248,
      249,
    ],
    [
      "sequence participant boxes",
      (count: number) =>
        `sequenceDiagram\n${Array.from({ length: count }, (_, i) => `box Box${i}\nparticipant A${i}\nend`).join("\n")}`,
      125,
      126,
    ],
    [
      "sequence message edges",
      (count: number) =>
        `sequenceDiagram\n${Array.from({ length: count }, () => "A->>B: hello").join("\n")}`,
      250,
      251,
    ],
    [
      "ER relationship edges",
      (count: number) =>
        `erDiagram\n${Array.from({ length: count }, (_, i) => `A ||--o{ B : relation${i}`).join("\n")}`,
      250,
      251,
    ],
  ] as const)(
    "counts %s in the 250-item layout limit",
    async (_name, source, admitted, rejected) => {
      expect(await admitsParsedGraph(source(admitted))).toBe(true);
      expect(await admitsParsedGraph(source(rejected))).toBe(false);
    },
  );

  it("counts expanded flowchart edges instead of the number of source statements", async () => {
    const source = (leftCount: number, rightCount: number) =>
      `flowchart LR\n${Array.from({ length: leftCount }, (_, i) => `A${i}`).join(" & ")} --> ${Array.from({ length: rightCount }, (_, i) => `B${i}`).join(" & ")}`;
    expect(await admitsParsedGraph(source(15, 16))).toBe(true);
    expect(await admitsParsedGraph(source(16, 16))).toBe(false);
  });
});

describe("Mermaid opaque-origin iframe boundary", () => {
  it("does not grant parent DOM, storage, Node, or desktop capabilities", async () => {
    const nonce = crypto.randomUUID();
    const token = crypto.randomUUID();
    const frame = document.createElement("iframe");
    frame.dataset.mermaidSecurityFixture = "";
    frame.setAttribute("sandbox", "allow-scripts");

    // This fixed test-only script runs under the production nonce/CSP. It tests
    // browser-enforced authority, not Mermaid's own choice to avoid an API.
    const probe = `<script nonce="${nonce}">
      (async () => {
        let parentDom = false;
        let storage = false;
        let parentBridge = false;
        try { parentDom = !!parent.document; } catch {}
        try { storage = !!localStorage; } catch {}
        try { parentBridge = !!parent.desktopBridge; } catch {}
        const violation = new Promise(resolve => {
          addEventListener("securitypolicyviolation", event => {
            if (event.effectiveDirective === "connect-src") resolve(true);
          });
          setTimeout(() => resolve(false), 1000);
        });
        let subresourceDenied = false;
        try { await fetch("https://example.invalid/mermaid-security-probe"); }
        catch { subresourceDenied = true; }
        parent.postMessage({
          token: ${JSON.stringify(token)},
          parentDom, storage, parentBridge,
          bridge: "desktopBridge" in window,
          node: typeof require !== "undefined" || typeof process !== "undefined",
          origin: globalThis.origin,
          subresourceDenied,
          connectSrcViolated: await violation
        }, "*");
      })();
    </script>`;
    const report = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("Sandbox security probe did not reply"));
      }, 10_000);
      function receive(event: MessageEvent<unknown>) {
        if (
          event.source !== frame.contentWindow ||
          event.origin !== "null" ||
          !event.data ||
          typeof event.data !== "object" ||
          !("token" in event.data) ||
          event.data.token !== token
        )
          return;
        clearTimeout(timeout);
        window.removeEventListener("message", receive);
        resolve(event.data as Record<string, unknown>);
      }
      window.addEventListener("message", receive);
    });
    frame.srcdoc = createMermaidSandboxDocument(nonce).replace("</head>", `${probe}</head>`);
    document.body.append(frame);
    try {
      expect(await report).toEqual({
        token,
        parentDom: false,
        storage: false,
        parentBridge: false,
        bridge: false,
        node: false,
        origin: "null",
        subresourceDenied: true,
        connectSrcViolated: true,
      });
      expect(frame.contentDocument).toBeNull();
    } finally {
      frame.remove();
    }
  });

  it("admits only a fixed nonce spelling into the trusted sandbox document", () => {
    expect(() => createMermaidSandboxDocument('x" onload="alert(1)')).toThrow();
    const nonce = crypto.randomUUID();
    const document = createMermaidSandboxDocument(nonce);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain(`script-src 'nonce-${nonce}'`);
    expect(document).not.toContain("allow-same-origin");
    expect(document).not.toContain("'unsafe-eval'");
  });
});
