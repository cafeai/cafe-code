// Opaque-frame-only presentation adapter for Mermaid 12.0.0 at immutable
// 98a0945418c76238f15df2afaddbba4272656c3b. Its event-modeling renderer has no
// native SVG-label mode and serializes HTML <br> inside foreignObject. The app's
// SVG image policy must still reject every HTML integration point. Convert only
// this exact native shape into ordinary inert SVG text; do not allow HTML in the
// parent renderer, copy label styles, or reinterpret other diagram families.
(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const HTML = "http://www.w3.org/1999/xhtml";
  const MAX_BYTES = 2097152;
  const MAX_ITEMS = 250;
  const fail = () => {
    // Parser/label excerpts are private received content, not diagnostic text
    // that may be sent over the one-shot renderer boundary.
    throw new Error();
  };
  const attributes = (element, allowed, required = []) => {
    for (const attribute of element.attributes) if (!allowed.includes(attribute.name)) fail();
    for (const name of required) if (!element.hasAttribute(name)) fail();
  };
  const number = (element, name, minimum = 0, maximum = 100000) => {
    const raw = element.getAttribute(name);
    if (raw == null || raw.length > 64 || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
      fail();
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum) fail();
    return value;
  };
  const equal = (left, right) => {
    // Native decimal serialization preserves the arithmetic result; tolerate
    // only representation-scale rounding, not a materially different box.
    if (Math.abs(left - right) > Math.max(1, Math.abs(right)) * 1e-12) fail();
  };
  const style = (element, expected) => {
    attributes(element, ["style", "xmlns"], ["style"]);
    if (element.getAttribute("xmlns") != null && element.getAttribute("xmlns") !== HTML) fail();
    const entries = element
      .getAttribute("style")
      .split(";")
      .filter((part) => part.trim());
    const observed = new Map();
    for (const entry of entries) {
      const colon = entry.indexOf(":");
      if (colon < 1) fail();
      const key = entry.slice(0, colon).trim();
      const value = entry.slice(colon + 1).trim();
      if (observed.has(key) || expected[key] !== value) fail();
      observed.set(key, value);
    }
    if (observed.size !== Object.keys(expected).length) fail();
  };
  const element = (node, name, namespace = HTML) => {
    if (node?.nodeType !== 1 || node.localName !== name || node.namespaceURI !== namespace) fail();
    return node;
  };
  const children = (node, limit = MAX_ITEMS) => {
    if (node.childNodes.length > limit) fail();
    return [...node.childNodes];
  };
  const contentLines = (node) => {
    // Only text and native wrapLabel line breaks occur inside b/code. Reject
    // nested formatting, comments, links, scripts and resource-bearing markup
    // instead of extracting textContent from an arbitrary HTML subtree.
    const lines = [""];
    for (const child of children(node)) {
      if (child.nodeType === 3) {
        const value = child.textContent;
        for (const scalar of value) {
          const code = scalar.codePointAt(0);
          if (
            (code < 32 && ![9, 10, 13].includes(code)) ||
            (code >= 0xd800 && code <= 0xdfff) ||
            code === 0xfffe ||
            code === 0xffff
          )
            fail();
        }
        const parts = value.split(/\r\n|\r|\n/);
        lines[lines.length - 1] += parts[0];
        for (const part of parts.slice(1)) lines.push(part);
      } else {
        element(child, "br");
        attributes(child, []);
        if (child.childNodes.length) fail();
        lines.push("");
      }
      if (lines.length > MAX_ITEMS) fail();
    }
    return lines;
  };
  globalThis.cafeMermaidEventModelingSvgLabels = (input) => {
    if (
      typeof input !== "string" ||
      input.length > MAX_BYTES ||
      new TextEncoder().encode(input).length > MAX_BYTES ||
      /<!DOCTYPE|<!ENTITY|\u0000/i.test(input)
    )
      fail();
    // HTML parsing is needed solely for native void <br> spelling. A template
    // is never connected to a document: scripts/resources cannot become live,
    // and all HTML nodes are discarded before anything leaves this frame.
    const template = document.createElement("template");
    template.innerHTML = input;
    const roots = children(template.content).filter(
      (node) => !(node.nodeType === 3 && !node.textContent.trim()),
    );
    if (roots.length !== 1) fail();
    const svg = element(roots[0], "svg", SVG);
    const viewBoxTokens = svg
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/);
    // Number() admits JavaScript hexadecimal spellings that are not SVG
    // coordinates. Qualify the native decimal/exponent grammar before the
    // finite range check, rather than turning invalid SVG into new geometry.
    if (
      viewBoxTokens?.length !== 4 ||
      viewBoxTokens.some((token) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token))
    )
      fail();
    const viewBox = viewBoxTokens.map(Number);
    if (
      viewBox.some((value) => !Number.isFinite(value) || Math.abs(value) > 100000) ||
      viewBox[2] < 1 ||
      viewBox[3] < 1
    )
      fail();
    const nativeTags = new Set([
      "svg",
      "g",
      "style",
      "rect",
      "text",
      "path",
      "defs",
      "marker",
      "polygon",
      "title",
      "desc",
    ]);
    let visited = 0;
    const pending = [[svg, 0]];
    const foreignObjects = [];
    while (pending.length) {
      const [node, depth] = pending.pop();
      if (++visited > 10000 || depth > 16) fail();
      if (node.nodeType === 3) continue;
      if (node.nodeType !== 1) fail();
      if (node.namespaceURI !== SVG) fail();
      for (const attribute of node.attributes)
        if (/^on/i.test(attribute.name) || /^(?:href|xlink:href|src)$/i.test(attribute.name))
          fail();
      if (node.localName === "foreignObject") {
        foreignObjects.push(node);
        if (foreignObjects.length > MAX_ITEMS) fail();
        continue; // The exact fixed HTML structure is inspected separately.
      }
      if (!nativeTags.has(node.localName) || (node !== svg && node.localName === "svg")) fail();
      // Parent admission remains authoritative, but its viewBox contract is
      // not a proof that every emitted native coordinate is finite. Qualify
      // this pinned renderer's scalar geometry and simple relation/marker
      // paths before converting any labels; unknown geometry is not text.
      for (const name of [
        "x",
        "y",
        "width",
        "height",
        "rx",
        "font-size",
        "stroke-width",
        "markerWidth",
        "markerHeight",
        "refX",
        "refY",
      ])
        if (
          node.hasAttribute(name) &&
          !(node === svg && name === "width" && node.getAttribute(name) === "100%")
        )
          number(node, name);
      if (node.localName === "path") {
        if (node.getAttribute("class") !== "em-relation") fail();
        const value = node.getAttribute("d");
        const scalar = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?";
        const relation = new RegExp(
          `^M\\s*(${scalar})[\\s,]+(${scalar})\\s+L\\s*(${scalar})[\\s,]+(${scalar})$`,
          "i",
        ).exec(value ?? "");
        if (
          !relation ||
          relation
            .slice(1)
            .some(
              (coordinate) =>
                !Number.isFinite(Number(coordinate)) || Math.abs(Number(coordinate)) > 100000,
            )
        )
          fail();
      }
      if (node.localName === "polygon") {
        const value = node.getAttribute("points");
        if (value == null || !/^[+\-\d.eE,\s]+$/.test(value)) fail();
        const coordinates = value
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        if (
          coordinates.length !== 6 ||
          coordinates.some(
            (coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 100000,
          )
        )
          fail();
      }
      for (const child of children(node, 10000)) pending.push([child, depth + 1]);
    }
    if (!foreignObjects.length) fail();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) fail();
    let totalLines = 0;
    let totalCharacters = 0;
    for (const foreignObject of foreignObjects) {
      attributes(foreignObject, ["x", "y", "width", "height"], ["x", "y", "width", "height"]);
      const group = element(foreignObject.parentNode, "g", SVG);
      attributes(group, ["class"], ["class"]);
      if (group.getAttribute("class") !== "em-box") fail();
      const siblings = children(group);
      if (siblings.length !== 2 || siblings[1] !== foreignObject) fail();
      const rect = element(siblings[0], "rect", SVG);
      attributes(
        rect,
        ["x", "y", "rx", "width", "height", "stroke", "fill"],
        ["x", "y", "rx", "width", "height", "stroke", "fill"],
      );
      for (const paint of [rect.getAttribute("stroke"), rect.getAttribute("fill")])
        if (/[\\@]|\/\*|url\s*\(|(?:expression|image|image-set)\s*\(/i.test(paint)) fail();
      const x = number(foreignObject, "x");
      const y = number(foreignObject, "y");
      // These bounds are pinned native boxMin/MaxWidth/Height plus boxPadding,
      // not source-controlled layout configuration or a generic HTML rectangle.
      const width = number(foreignObject, "width", 80, 450);
      const height = number(foreignObject, "height", 80, 750);
      equal(x, number(rect, "x") + 10);
      equal(y, number(rect, "y") + 10);
      equal(width, number(rect, "width", 100, 470) - 20);
      equal(height, number(rect, "height", 100, 770) - 20);
      equal(number(rect, "rx"), 3);
      const outer = children(foreignObject);
      if (outer.length !== 1) fail();
      const div = element(outer[0], "div");
      style(div, { display: "table", height: "100%", width: "100%" });
      const inner = children(div);
      if (inner.length !== 1) fail();
      const span = element(inner[0], "span");
      style(span, { display: "table-cell", "text-align": "center", "vertical-align": "middle" });
      const parts = children(span);
      if (parts.length !== 1 && parts.length !== 4) fail();
      const bold = element(parts[0], "b");
      attributes(bold, []);
      const lines = contentLines(bold).map((text) => ({ text, bold: true }));
      if (!lines.some((line) => line.text)) fail();
      if (parts.length === 4) {
        for (const separator of parts.slice(1, 3)) {
          element(separator, "br");
          attributes(separator, []);
          if (separator.childNodes.length) fail();
        }
        const code = element(parts[3], "code");
        style(code, { "text-align": "left", display: "block", "max-width": "430px" });
        lines.push({ text: "", bold: false }); // Preserve the two native BRs.
        for (const text of contentLines(code)) lines.push({ text, bold: false });
      }
      totalLines += lines.length;
      for (const line of lines) totalCharacters += line.text.length;
      if (totalLines > MAX_ITEMS || totalCharacters > 32768) fail();
      // Preserve the native 16px font where it fits. Finite small-box fitting
      // may reduce to 8px and compress an overwide line by at most 2x. Anything
      // requiring smaller/denser text is source-only, never silently truncated.
      const fontSize = Math.min(16, height / (lines.length * 1.25));
      if (!Number.isFinite(fontSize) || fontSize < 8) fail();
      const lineHeight = fontSize * 1.25;
      const firstY = y + (height - lines.length * lineHeight) / 2 + fontSize;
      const text = document.createElementNS(SVG, "text");
      text.setAttribute("font-size", String(fontSize));
      for (const [index, line] of lines.entries()) {
        const family = line.bold ? "Arial,sans-serif" : "monospace";
        context.font = `${line.bold ? "700" : "400"} ${fontSize}px ${family}`;
        const measured = context.measureText(line.text).width;
        if (!Number.isFinite(measured) || measured < 0 || measured > width * 2) fail();
        const tspan = document.createElementNS(SVG, "tspan");
        tspan.setAttribute("x", String(line.bold ? x + width / 2 : x));
        tspan.setAttribute("y", String(firstY + index * lineHeight));
        tspan.setAttribute("text-anchor", line.bold ? "middle" : "start");
        tspan.setAttribute("font-family", family);
        tspan.setAttribute("font-weight", line.bold ? "700" : "400");
        tspan.setAttribute("style", "white-space: pre;");
        if (measured > width) {
          tspan.setAttribute("textLength", String(width));
          tspan.setAttribute("lengthAdjust", "spacingAndGlyphs");
        }
        tspan.textContent = line.text;
        text.append(tspan);
      }
      foreignObject.replaceWith(text);
    }
    const output = new XMLSerializer().serializeToString(svg);
    if (new TextEncoder().encode(output).length > MAX_BYTES) fail();
    return output;
  };
})();
