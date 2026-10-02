// This file is loaded as inert source text, not imported into Cafe's JS realm.
// Keep it self-contained: the only authority is a one-use MessagePort from the
// parent that created this opaque-origin frame with subresource traffic denied.
(() => {
  window.addEventListener("message", async function receive(event) {
    if (event.source !== parent || event.data !== "cafe-mermaid-render" || event.ports.length !== 1)
      return;
    window.removeEventListener("message", receive);
    const port = event.ports[0];
    port.onmessage = async ({ data }) => {
      port.onmessage = null;
      try {
        if (
          !data ||
          typeof data.id !== "string" ||
          data.id.length > 64 ||
          typeof data.source !== "string" ||
          data.source.length > 32768 ||
          new TextEncoder().encode(data.source).length > 32768 ||
          (data.theme !== "dark" && data.theme !== "light") ||
          /%%\s*\{/.test(data.source) ||
          data.source.trimStart().startsWith("---") ||
          /(?:^|[;\r\n])\s*(?:click|links?)\s/i.test(data.source) ||
          // Match the parent scan's bounded brace segment. Canonical image
          // nodes are separately rejected after parsing below.
          /@\s*\{[^{}]*["']?\bimg\b["']?\s*:/i.test(data.source) ||
          "desktopBridge" in window
        )
          throw new Error();

        // Reject source configuration entirely; strict is not sufficient if a
        // diagram can replace security/layout/theme settings via frontmatter.
        const mermaid = globalThis.mermaid;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          logLevel: "fatal",
          maxTextSize: 32768,
          maxEdges: 250,
          theme: data.theme === "dark" ? "dark" : "default",
          fontFamily: "Arial, sans-serif",
          htmlLabels: false,
          flowchart: { htmlLabels: false, defaultRenderer: "dagre-wrapper" },
          class: { htmlLabels: false },
          look: "classic",
          layout: "dagre",
          deterministicIds: true,
          deterministicIDSeed: "cafe",
        });

        const diagram = await mermaid.mermaidAPI.getDiagramFromText(data.source);
        const db = diagram.db;
        const size = (items) => {
          if (items instanceof Map || items instanceof Set) return items.size;
          if (Array.isArray(items)) return items.length;
          if (items && typeof items === "object") {
            const prototype = Object.getPrototypeOf(items);
            if (prototype === Object.prototype || prototype === null) {
              return Object.keys(items).length;
            }
          }
          // A renderer upgrade changing its database API is not evidence of
          // an empty graph. Reject unfamiliar shapes rather than bypass limits.
          throw new Error();
        };
        const layoutSize = () => {
          const graph = db.getData();
          if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
            throw new Error();
          }
          // Source spellings can encode YAML/JSON property names. Bind the
          // image prohibition to the parsed graph as well: Mermaid 12.0.0
          // turns an img-bearing flowchart vertex into imageSquare and starts
          // loading its image during layout, before our output sanitizer runs.
          if (
            graph.nodes.some(
              (node) =>
                !node ||
                typeof node !== "object" ||
                node.img != null ||
                node.shape === "image" ||
                node.shape === "imageSquare",
            )
          )
            throw new Error();
          return [graph.nodes.length, graph.edges.length];
        };
        let nodes;
        let edges;
        switch (diagram.type) {
          case "flowchart":
          case "flowchart-v2":
            // The pinned database synthesizes layout nodes for subgraphs.
            // Counting only getVertices() would omit those containers.
            [nodes, edges] = layoutSize();
            break;
          case "sequence":
            // Participant boxes are rendered containers, not actor entries.
            nodes = size(db.getActors()) + size(db.getBoxes());
            edges = size(db.getMessages());
            break;
          case "class":
          case "classDiagram":
            // getData() includes every nested namespace, lollipop-interface
            // node, and note-attachment edge as well as ordinary classes and
            // relations. These are all work for the layout engine, including
            // containers with only a few actual class declarations.
            [nodes, edges] = layoutSize();
            break;
          case "er":
            nodes = size(db.getEntities());
            edges = size(db.getRelationships());
            break;
          case "state":
          case "stateDiagram":
            // State diagrams expose the flattened graph after parsing. This
            // includes nested groups and synthesized start/end nodes.
            [nodes, edges] = layoutSize();
            break;
          default:
            throw new Error();
        }
        if (nodes > 250 || edges > 250) throw new Error();
        const { svg } = await mermaid.render("cafe-diagram", data.source);
        if (
          typeof svg !== "string" ||
          svg.length > 2097152 ||
          new TextEncoder().encode(svg).length > 2097152
        )
          throw new Error();
        // No bindFunctions: callbacks and interactive links are not part of
        // Cafe's diagram contract. The parent validates and sanitizes again.
        port.postMessage({ id: data.id, svg });
      } catch {
        // Never send parser errors: they can contain a private source excerpt.
        port.postMessage({ id: data?.id, failed: true });
      } finally {
        port.close();
      }
    };
    port.start();
  });
})();
