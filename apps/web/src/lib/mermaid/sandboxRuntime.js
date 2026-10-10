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
          /(?:^|[;\r\n])\s*click\s/i.test(data.source) ||
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
        // The pinned flowchart grammar has no standalone link/links directive;
        // LINK is a valid node ID, unlike sequence/class link declarations.
        // Bind this exception to the actual parsed type; preserve the existing
        // case-insensitive ban otherwise, before any layout or callback.
        if (
          diagram.type !== "flowchart" &&
          diagram.type !== "flowchart-v2" &&
          /(?:^|[;\r\n])\s*links?\s/i.test(data.source)
        ) {
          throw new Error();
        }
        const record = (value) => {
          if (
            !value ||
            typeof value !== "object" ||
            Object.getPrototypeOf(value) !== Object.prototype
          ) {
            throw new Error();
          }
          return value;
        };
        const finite = (value) => {
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error();
          return value;
        };
        const list = (value) => {
          if (!Array.isArray(value) || value.length === 0 || value.length > 250) throw new Error();
          return value;
        };
        // Mirror only the pinned d3-array 3.2.4 default ten-tick calculation,
        // without allocating its array. Finite endpoints alone are insufficient:
        // overflowing spans or subnormal reciprocal steps yield empty/infinite
        // ticks and unsafe axis padding in Tiny. Requalify this with engine pins.
        const axisTicks = (axis) => {
          record(axis);
          if (axis.type !== "linear" || typeof axis.title !== "string") throw new Error();
          let start = finite(axis.min);
          let stop = finite(axis.max);
          if (start === stop) return 1;
          if (stop < start) [start, stop] = [stop, start];
          const step = finite((stop - start) / 10);
          if (step <= 0) throw new Error();
          const power = Math.floor(Math.log10(step));
          const magnitude = finite(10 ** power);
          if (magnitude <= 0) throw new Error();
          const error = finite(step / magnitude);
          const factor =
            error >= Math.sqrt(50)
              ? 10
              : error >= Math.sqrt(10)
                ? 5
                : error >= Math.sqrt(2)
                  ? 2
                  : 1;
          const reciprocal = power < 0;
          const increment = finite(reciprocal ? 10 ** -power / factor : magnitude * factor);
          if (increment <= 0) throw new Error();
          let first = Math.round(finite(reciprocal ? start * increment : start / increment));
          let last = Math.round(finite(reciprocal ? stop * increment : stop / increment));
          if ((reciprocal ? first / increment : first * increment) < start) first++;
          if ((reciprocal ? last / increment : last * increment) > stop) last--;
          const count = finite(last - first + 1);
          if (!Number.isInteger(count) || count < 1 || count > 250) throw new Error();
          // Also prove every eventual tick coordinate is finite without retaining
          // attacker-sized intermediate arrays. The loop has an admitted bound.
          for (let index = first; index <= last; index++) {
            finite(reciprocal ? index / increment : index * increment);
            // Large endpoints can round index + 1 back to index. Do not hang.
            if (index + 1 === index && index < last) throw new Error();
            if (index === last) break;
          }
          return count;
        };
        const within = (value, axis) =>
          value >= Math.min(axis.min, axis.max) && value <= Math.max(axis.min, axis.max);
        const xySize = () => {
          const chart = record(db.getXYChartData());
          const xAxis = record(chart.xAxis);
          const yTicks = axisTicks(chart.yAxis);
          const plots = list(chart.plots);
          let categories;
          let xTicks;
          if (xAxis.type === "band") {
            if (typeof xAxis.title !== "string") throw new Error();
            const labels = list(xAxis.categories);
            // for-of also checks sparse holes; Array.some would skip them.
            for (const label of labels) if (typeof label !== "string") throw new Error();
            categories = new Set(labels);
            xTicks = labels.length;
          } else {
            xTicks = axisTicks(xAxis);
          }
          let points = 0;
          let pointLabels = 0;
          for (const plot of plots) {
            record(plot);
            if ((plot.type !== "bar" && plot.type !== "line") || typeof plot.title !== "string")
              throw new Error();
            const values = list(plot.data);
            points += values.length;
            if (points > 250) throw new Error();
            // Tiny retains original point labels even when band data truncates.
            // Bound those separately rather than relying on visible point count.
            if (plot.pointLabels !== undefined) {
              if (!Array.isArray(plot.pointLabels)) throw new Error();
              pointLabels += plot.pointLabels.length;
              if (pointLabels > 250) throw new Error();
              for (const label of plot.pointLabels)
                if (typeof label !== "string") throw new Error();
            }
            for (const pair of values) {
              if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string")
                throw new Error();
              const value = finite(pair[1]);
              if (!within(value, chart.yAxis)) throw new Error();
              if (categories) {
                if (!categories.has(pair[0])) throw new Error();
              } else {
                // The pinned database stringifies numeric X positions. Empty
                // strings are not numeric positions, despite Number("") === 0.
                if (pair[0].trim() === "" || !within(finite(Number(pair[0])), xAxis))
                  throw new Error();
              }
            }
          }
          return [xTicks + yTicks + plots.length, points];
        };
        const pieSize = () => {
          const sections = db.getSections();
          if (
            !(sections instanceof Map) ||
            sections.size === 0 ||
            sections.size > 250 ||
            typeof db.getShowData() !== "boolean"
          )
            throw new Error();
          let total = 0;
          for (const [label, value] of sections) {
            if (typeof label !== "string" || finite(value) < 0) throw new Error();
            total = finite(total + value);
          }
          if (total <= 0) throw new Error();
          // Tiny omits slices below1% from geometry but retains their legends.
          // Validate the actual visible angular denominator, not just total.
          let visibleTotal = 0;
          for (const value of sections.values()) {
            if ((value / total) * 100 >= 1) visibleTotal = finite(visibleTotal + value);
          }
          if (visibleTotal <= 0 || finite((2 * Math.PI) / visibleTotal) <= 0) throw new Error();
          return [sections.size, sections.size];
        };
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
          case "xychart":
            [nodes, edges] = xySize();
            break;
          case "pie":
            [nodes, edges] = pieSize();
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
