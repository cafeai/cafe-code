// Opaque-frame-only compatibility for the immutable Mermaid 12.0.0 info
// renderer. Native configureSvgSize(100, 400, true) forgets its viewBox. Bind
// only that exact version-label output to those fixed native dimensions;
// never infer arbitrary diagram dimensions or weaken the parent SVG policy.
(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const fail = () => {
    throw new Error();
  };
  const attributes = (element, expected) => {
    if (element.attributes.length !== Object.keys(expected).length) fail();
    for (const [name, value] of Object.entries(expected))
      if (element.getAttribute(name) !== value) fail();
  };
  globalThis.cafeMermaidInfoSvgViewport = (input) => {
    if (
      typeof input !== "string" ||
      input.length > 2097152 ||
      new TextEncoder().encode(input).length > 2097152 ||
      /<!DOCTYPE|<!ENTITY|\u0000/i.test(input)
    )
      fail();
    const document = new DOMParser().parseFromString(input, "image/svg+xml");
    const root = document.documentElement;
    if (
      root.localName !== "svg" ||
      root.namespaceURI !== SVG ||
      document.querySelector("parsererror") ||
      document.childNodes.length !== 1
    )
      fail();
    attributes(root, {
      id: "cafe-diagram",
      width: "100%",
      xmlns: SVG,
      style: "max-width: 400px;",
      role: "graphics-document document",
      "aria-roledescription": "info",
    });
    // Native output is precisely style + an empty Mermaid container + the
    // version text group. Reject extra elements, text, attributes or markup
    // instead of synthesizing a viewport for an unreviewed future renderer.
    const nodes = [...root.childNodes];
    if (
      nodes.length !== 3 ||
      nodes.some((node) => node.nodeType !== 1 || node.namespaceURI !== SVG)
    )
      fail();
    const [style, empty, group] = nodes;
    if (
      style.localName !== "style" ||
      style.attributes.length ||
      style.childNodes.length !== 1 ||
      style.firstChild.nodeType !== 3 ||
      empty.localName !== "g" ||
      empty.attributes.length ||
      empty.childNodes.length ||
      group.localName !== "g" ||
      group.attributes.length ||
      group.childNodes.length !== 1
    )
      fail();
    const label = group.firstChild;
    if (
      label.nodeType !== 1 ||
      label.localName !== "text" ||
      label.namespaceURI !== SVG ||
      label.childNodes.length !== 1 ||
      label.firstChild.nodeType !== 3 ||
      label.textContent !== "v12.0.0"
    )
      fail();
    attributes(label, {
      x: "100",
      y: "40",
      class: "version",
      "font-size": "32",
      style: "text-anchor: middle;",
    });
    // The unchanged independent parent sanitizer still validates all CSS and
    // attributes. No source-controlled CSS or version label is copied anew.
    root.setAttribute("viewBox", "0 0 400 100");
    return new XMLSerializer().serializeToString(root);
  };
})();
