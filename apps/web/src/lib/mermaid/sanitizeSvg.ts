import DOMPurify from "dompurify";
import { MAX_MERMAID_SVG_BYTES, MERMAID_FAILURE } from "./policy";

export interface MermaidResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
}

// This policy deliberately does not share Shiki's HTML sanitizer. Mermaid's
// result is untrusted even after its own sanitization and sandbox execution.
const TAGS = [
  "svg",
  "g",
  "defs",
  "marker",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "style",
  "clipPath",
];
const ATTRIBUTES = [
  "xmlns",
  "id",
  "class",
  "style",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "transform",
  "text-anchor",
  "dominant-baseline",
  "dy",
  "dx",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "textLength",
  "lengthAdjust",
  "marker-start",
  "marker-mid",
  "marker-end",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "orient",
  "refX",
  "refY",
  "clip-path",
  "preserveAspectRatio",
  "role",
  "aria-labelledby",
  "aria-describedby",
];
const STYLE_PROPERTIES = new Set([
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "text-align",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "line-height",
  "white-space",
  "visibility",
  "display",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

function filterStyle(style: CSSStyleDeclaration): string {
  // No filters, transforms, layout rules, custom properties, transitions or
  // animations from user-authored classDef/style directives enter the image.
  for (const property of Array.from(style)) {
    if (!STYLE_PROPERTIES.has(property)) style.removeProperty(property);
  }
  return style.cssText;
}

function safeStyle(value: string, stylesheet = false): boolean {
  // CSS escapes/comments can disguise resource-bearing tokens. Mermaid's own
  // generated CSS needs neither; reject instead of attempting a second CSS
  // parser. Only same-image fragment URLs are useful (markers and clip paths).
  const withoutFragments = value.replace(/url\(\s*["']?#[\w-]+["']?\s*\)/gi, "");
  const withoutKeyframes = stylesheet
    ? withoutFragments.replace(/@keyframes\b/g, "")
    : withoutFragments;
  return !/[\\@]|\/\*|url\s*\(|(?:expression|image|image-set)\s*\(/i.test(withoutKeyframes);
}

export function sanitizeMermaidSvg(input: unknown): MermaidResult {
  if (
    typeof input !== "string" ||
    input.length > MAX_MERMAID_SVG_BYTES ||
    new TextEncoder().encode(input).byteLength > MAX_MERMAID_SVG_BYTES ||
    /<!DOCTYPE|<!ENTITY/i.test(input)
  )
    throw new Error(MERMAID_FAILURE);

  const purified = DOMPurify.sanitize(input, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Keep SVG namespaces and reject HTML integration points, external images,
    // use references, links, animation and foreignObject even on future pins.
    NAMESPACE: "http://www.w3.org/2000/svg",
    PARSER_MEDIA_TYPE: "application/xhtml+xml",
  });
  const document = new DOMParser().parseFromString(purified, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error(MERMAID_FAILURE);
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.localName === "style") {
      const css = element.textContent ?? "";
      if (!safeStyle(css, true)) throw new Error(MERMAID_FAILURE);
      // Mermaid includes keyframes even for static graphs. Parse CSS only after
      // rejecting resource-bearing syntax; a constructed sheet is never attached
      // to the page. Retain ordinary rules, remove animation definitions and
      // properties so background diagrams cannot consume repaint work forever.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      const rules: string[] = [];
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule) {
          filterStyle(rule.style);
          // Serialize only this declaration block. CSS nesting can hide child
          // rules inside CSSStyleRule.cssText; those children have not passed
          // the property policy and must never be copied through implicitly.
          rules.push(`${rule.selectorText} { ${rule.style.cssText} }`);
        }
      }
      element.textContent = rules.join("\n");
    }
    for (const attribute of element.attributes) {
      if (!safeStyle(attribute.value)) throw new Error(MERMAID_FAILURE);
      if (attribute.name === "style") {
        const style = document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "span",
        ) as HTMLSpanElement;
        style.style.cssText = attribute.value;
        attribute.value = filterStyle(style.style);
      }
    }
  }
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = box?.[2];
  const height = box?.[3];
  if (
    box?.length !== 4 ||
    !box.every(Number.isFinite) ||
    !width ||
    !height ||
    width < 1 ||
    height < 1 ||
    width > 100_000 ||
    height > 100_000
  )
    throw new Error(MERMAID_FAILURE);
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  const title =
    [root.querySelector("title")?.textContent, root.querySelector("desc")?.textContent]
      .filter(Boolean)
      .join(". ")
      .slice(0, 1024) || "Mermaid diagram";
  const svg = new XMLSerializer().serializeToString(root);
  if (new TextEncoder().encode(svg).byteLength > MAX_MERMAID_SVG_BYTES) {
    throw new Error(MERMAID_FAILURE);
  }
  return Object.freeze({ svg, width, height, title });
}
