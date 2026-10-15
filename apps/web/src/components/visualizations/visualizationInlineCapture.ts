import { uiText } from "@cafecode/shared/i18n";
import {
  VISUALIZATION_FONT_DATA,
  VISUALIZATION_FONT_LICENSE,
} from "@cafecode/shared/visualizationFontData";

import { rasterizeSvgToPng } from "../../lib/imageExport";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_NODES = 20_000;
const MAX_DEPTH = 100;
const MAX_TEXT_CHARACTERS = 1_000_000;
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_PIXELS = 4_194_304;
const MAX_EMBEDDED_CHARACTERS = 4 * 1024 * 1024;
const MAX_RASTERS = 128;
const failure = () => new Error(uiText("This image could not be exported."));

/** These are current-frame capture bounds, not permission to execute a frame
 * or a promise that a same-origin document is contained. Full-access admission
 * and the frame's lifecycle remain the caller's separate responsibilities. */
export function admitInlineVisualizationCaptureSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 1600 ||
    height > 2000 ||
    width * height > 3_200_000
  )
    throw failure();
  return { width, height };
}

/** The live document may fill a wider chat column without increasing the PNG
 * allocation. Preserve its original CSS coordinate system and uniformly fit
 * that inert snapshot into the existing physical output bounds. SVG's default
 * meet mapping handles any subpixel rounding as a themed edge, never independent
 * X/Y stretching of chart labels, circles or other foreground geometry. */
export function admitInlineVisualizationCaptureSourceSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 2000
  )
    throw failure();
  const scale = Math.min(1, 1600 / width);
  const output = admitInlineVisualizationCaptureSize(
    Math.max(1, Math.ceil(width * scale)),
    Math.max(1, Math.ceil(height * scale)),
  );
  return { source: { width, height }, output };
}

// Rebuild only inert presentation. No live clone, authored stylesheet, event,
// URL, form action, embedded document or capability attribute is copied. The
// independent SVG image admission in imageExport checks the final result too.
const HTML_TAGS = new Set([
  "div",
  "span",
  "p",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "code",
  "pre",
  "br",
  "small",
  "sub",
  "sup",
  "mark",
  "abbr",
  "kbd",
  "samp",
  "var",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
]);
const CONTAINER_TAGS = new Set([
  "body",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "figure",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "form",
  "button",
  "label",
  "fieldset",
  "legend",
  "details",
  "summary",
  "a",
]);
const OMIT_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "title",
  "base",
  "noscript",
  "template",
]);
const SVG_TAGS = new Set([
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
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "foreignObject",
]);
const SVG_ATTRIBUTES = new Set([
  "viewBox",
  "preserveAspectRatio",
  "d",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "dx",
  "dy",
  "width",
  "height",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "points",
  "fill-rule",
  "clip-rule",
  "pathLength",
  "textLength",
  "lengthAdjust",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "offset",
  "fx",
  "fy",
  "fr",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "clipPathUnits",
]);
const PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-collapse",
  "border-spacing",
  "table-layout",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "color",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "box-shadow",
  "opacity",
  "visibility",
  "filter",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-kerning",
  "font-feature-settings",
  "font-variant",
  "font-variation-settings",
  "font-optical-sizing",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-underline-offset",
  "text-overflow",
  "white-space",
  "vertical-align",
  "overflow-wrap",
  "word-break",
  "direction",
  "unicode-bidi",
  "overflow-x",
  "overflow-y",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "justify-self",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-auto-flow",
  "grid-column-start",
  "grid-column-end",
  "grid-row-start",
  "grid-row-end",
  "transform",
  "transform-origin",
  "object-fit",
  "object-position",
  "list-style-type",
  "list-style-position",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
] as const;

interface Budget {
  nodes: number;
  text: number;
  presentation: number;
  rasterPixels: number;
  rasterCharacters: number;
  rasters: number;
  ids: Set<string>;
  paints: Set<string>;
}

function boundedPresentation(value: string, sourceDocument: Document, budget: Budget): string {
  budget.presentation += value.length;
  if (
    value.length > 8192 ||
    budget.presentation > MAX_SERIALIZED_BYTES ||
    /[\\<>@]|\/\*/.test(value)
  )
    throw failure();
  // Computed SVG paint URLs may be absolute about:srcdoc URLs. Admit only the
  // exact source document and a finite local paint ID; never retain an origin,
  // data image, stylesheet URL or another document merely sharing a prefix.
  const normalized = value.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (_match, raw: string) => {
    let url: URL;
    try {
      url = new URL(raw.trim(), sourceDocument.URL);
    } catch {
      throw failure();
    }
    const source = new URL(sourceDocument.URL);
    source.hash = "";
    const hash = url.hash;
    url.hash = "";
    if (url.href !== source.href || !/^#[\w-]{1,128}$/.test(hash)) throw failure();
    budget.paints.add(hash.slice(1));
    return `url(${hash})`;
  });
  if (
    /url\s*\(/i.test(normalized.replace(/url\(#[\w-]+\)/g, "")) ||
    /image\s*\(|image-set\s*\(|expression\s*\(/i.test(normalized)
  )
    throw failure();
  return normalized;
}

function copyPresentation(
  source: Element,
  target: HTMLElement | SVGElement,
  view: Window,
  budget: Budget,
) {
  const style = view.getComputedStyle(source);
  for (const property of PROPERTIES) {
    const value = boundedPresentation(
      style.getPropertyValue(property),
      source.ownerDocument,
      budget,
    );
    if (value) target.style.setProperty(property, value);
  }
}

function snapshotRaster(
  source: HTMLCanvasElement | HTMLImageElement,
  view: Window,
  targetDocument: Document,
  budget: Budget,
): HTMLImageElement {
  const canvasSource = source.localName === "canvas";
  const width = canvasSource
    ? (source as HTMLCanvasElement).width
    : (source as HTMLImageElement).naturalWidth;
  const height = canvasSource
    ? (source as HTMLCanvasElement).height
    : (source as HTMLImageElement).naturalHeight;
  budget.rasters++;
  budget.rasterPixels += width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    budget.rasters > MAX_RASTERS ||
    budget.rasterPixels > MAX_EMBEDDED_PIXELS ||
    (!canvasSource && !(source as HTMLImageElement).complete)
  )
    throw failure();
  let data: string;
  if (canvasSource) {
    // Read the current backing buffer synchronously, before any decode/await.
    // A tainted/unreadable buffer fails; no retained poster or substitute paint
    // is available. The bundled fluid explicitly preserves its drawing buffer.
    data = (source as HTMLCanvasElement).toDataURL("image/png");
  } else {
    const buffer = document.createElement("canvas");
    try {
      buffer.width = width;
      buffer.height = height;
      const context = buffer.getContext("2d");
      if (!context) throw failure();
      context.drawImage(source as HTMLImageElement, 0, 0);
      data = buffer.toDataURL("image/png");
    } finally {
      buffer.width = 0;
      buffer.height = 0;
    }
  }
  budget.rasterCharacters += data.length;
  if (
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data) ||
    budget.rasterCharacters > MAX_EMBEDDED_CHARACTERS
  )
    throw failure();
  const image = targetDocument.createElementNS(HTML_NAMESPACE, "img") as HTMLImageElement;
  image.src = data;
  copyPresentation(source, image, view, budget);
  return image;
}

function snapshotNode(
  source: Node,
  view: Window,
  targetDocument: Document,
  budget: Budget,
  depth = 0,
): Node | null {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw failure();
  if (source.nodeType === 3) {
    const value = source.textContent ?? "";
    budget.text += value.length;
    if (budget.text > MAX_TEXT_CHARACTERS) throw failure();
    return targetDocument.createTextNode(value);
  }
  if (source.nodeType !== 1) return null;
  const element = source as Element;
  const tag = element.localName;
  const svg = element.namespaceURI === SVG_NAMESPACE;
  if (!svg && (element.namespaceURI !== HTML_NAMESPACE || OMIT_TAGS.has(tag))) return null;
  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")
    return null;
  for (const pseudo of ["::before", "::after"]) {
    const content = view.getComputedStyle(element, pseudo).content;
    if (content !== "none" && content !== "normal" && content !== '""') throw failure();
  }
  if (!svg && (tag === "canvas" || tag === "img"))
    return snapshotRaster(
      element as HTMLCanvasElement | HTMLImageElement,
      view,
      targetDocument,
      budget,
    );
  let replacement = svg ? tag : HTML_TAGS.has(tag) ? tag : CONTAINER_TAGS.has(tag) ? "div" : null;
  let controlText: string | undefined;
  if (!svg && tag === "input") {
    const input = element as HTMLInputElement;
    if (input.type === "hidden") return null;
    if (
      !["text", "number", "search", "email", "url", "tel", "button", "submit", "reset"].includes(
        input.type,
      )
    )
      throw failure();
    replacement = "div";
    controlText = input.value || input.placeholder;
  } else if (!svg && tag === "textarea") {
    replacement = "div";
    controlText = (element as HTMLTextAreaElement).value;
  } else if (!svg && tag === "select") {
    replacement = "div";
    controlText = Array.from(
      (element as HTMLSelectElement).selectedOptions,
      (option) => option.label,
    ).join(" ");
  }
  if (!replacement || (svg && !SVG_TAGS.has(tag))) throw failure();
  const target = targetDocument.createElementNS(
    svg ? SVG_NAMESPACE : HTML_NAMESPACE,
    replacement,
  ) as HTMLElement | SVGElement;
  copyPresentation(element, target, view, budget);
  if (svg) {
    const id = element.getAttribute("id");
    if (id) {
      if (!/^[\w-]{1,128}$/.test(id) || budget.ids.has(id)) throw failure();
      budget.ids.add(id);
      target.setAttribute("id", id);
    }
    for (const attribute of element.attributes) {
      if (!SVG_ATTRIBUTES.has(attribute.name)) continue;
      target.setAttribute(
        attribute.name,
        boundedPresentation(attribute.value, element.ownerDocument, budget),
      );
    }
    const href =
      element.getAttribute("href") ??
      element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (href) {
      if (!/^#[\w-]{1,128}$/.test(href)) throw failure();
      budget.paints.add(href.slice(1));
      target.setAttribute("href", href);
    }
  } else if (["td", "th", "col"].includes(tag)) {
    for (const name of ["colspan", "rowspan", "span"]) {
      const value = element.getAttribute(name);
      if (value && /^[1-9]\d{0,3}$/.test(value)) target.setAttribute(name, value);
    }
  }
  if (controlText !== undefined) {
    budget.text += controlText.length;
    if (budget.text > MAX_TEXT_CHARACTERS) throw failure();
    target.append(targetDocument.createTextNode(controlText));
  } else {
    for (let child = source.firstChild; child; child = child.nextSibling) {
      // Closed disclosure bodies are not currently painted. Retain only their
      // real summary instead of accidentally exporting hidden detail text.
      if (
        !svg &&
        tag === "details" &&
        !(element as HTMLDetailsElement).open &&
        (child.nodeType !== 1 || (child as Element).localName !== "summary")
      )
        continue;
      const copy = snapshotNode(child, view, targetDocument, budget, depth + 1);
      if (copy) target.append(copy);
    }
  }
  return target;
}

/** Capture this exact live same-origin frame, never a saved preview or a native
 * screen/window. Source canvases become bounded raster data before the first
 * await, then only a rebuilt, inert SVG image is decoded. Unsupported visible
 * content refuses the export rather than silently inventing missing pixels. */
export async function captureInlineVisualization(
  frame: HTMLIFrameElement,
  signal: AbortSignal,
  current: () => boolean = () => true,
): Promise<Blob> {
  try {
    signal.throwIfAborted();
    const sourceDocument = frame.contentDocument;
    const view = frame.contentWindow;
    if (!sourceDocument || !view || !sourceDocument.body) throw failure();
    const { source: size, output } = admitInlineVisualizationCaptureSourceSize(
      view.innerWidth,
      view.innerHeight,
    );
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        !current() ||
        !frame.isConnected ||
        frame.contentDocument !== sourceDocument ||
        frame.contentWindow !== view ||
        view.innerWidth !== size.width ||
        view.innerHeight !== size.height ||
        sourceDocument.readyState === "loading" ||
        sourceDocument.hidden ||
        sourceDocument.documentElement.dataset.cafeVisible !== "true"
      )
        throw failure();
    };
    assertCurrent();
    // A font/layout still loading is not the current settled chart. Refuse
    // instead of waiting and quietly changing its text metrics before capture.
    if (sourceDocument.fonts.status !== "loaded") throw failure();
    const scrolling = sourceDocument.scrollingElement;
    if (
      !scrolling ||
      scrolling.scrollWidth > size.width + 1 ||
      scrolling.scrollHeight > size.height + 1
    )
      throw failure();
    const budget: Budget = {
      nodes: 0,
      text: 0,
      presentation: 0,
      rasterPixels: 0,
      rasterCharacters: 0,
      rasters: 0,
      ids: new Set(),
      paints: new Set(),
    };
    const targetDocument = document.implementation.createDocument(HTML_NAMESPACE, "div");
    const root = targetDocument.documentElement as HTMLElement;
    root.style.cssText = `width:${size.width}px;height:${size.height}px;overflow:hidden;position:relative;`;
    const fontStyle = targetDocument.createElementNS(HTML_NAMESPACE, "style");
    // Keep the complete fixed font license as inert SVG metadata. Its original
    // double hyphens must not be put in an invalid XML comment; the independent
    // CSS admission also deliberately rejects authored CSS comment syntax.
    const metadata = targetDocument.createElementNS(SVG_NAMESPACE, "svg");
    metadata.style.display = "none";
    const notice = targetDocument.createElementNS(SVG_NAMESPACE, "desc");
    notice.textContent = VISUALIZATION_FONT_LICENSE;
    metadata.append(notice);
    root.append(metadata);
    fontStyle.textContent = VISUALIZATION_FONT_DATA.map(
      (font) =>
        `@font-face{font-family:"DM Sans Variable";font-style:${font.style};font-weight:100 1000;src:url("data:font/woff2;base64,${font.base64}") format("woff2");unicode-range:${font.unicodeRange}}`,
    ).join("\n");
    root.append(fontStyle);
    const body = snapshotNode(sourceDocument.body, view, targetDocument, budget);
    if (!body) throw failure();
    root.append(body);
    if (Array.from(budget.paints).some((id) => !budget.ids.has(id))) throw failure();
    const bodyStyle = view.getComputedStyle(sourceDocument.body);
    const background =
      bodyStyle.getPropertyValue("--background").trim() ||
      view.getComputedStyle(sourceDocument.documentElement).backgroundColor;
    if (!CSS.supports("color", background)) throw failure();
    const content = new XMLSerializer().serializeToString(root);
    if (content.length > MAX_SERIALIZED_BYTES) throw failure();
    // The shared inert rasterizer intentionally maps its outer viewport to all
    // output pixels. Keep that outer viewBox already at output size, and use an
    // inner meet viewport for the original CSS coordinates. Rounding a very
    // thin document therefore cannot become independent axis/font stretching.
    const svg = `<svg xmlns="${SVG_NAMESPACE}" width="${output.width}" height="${output.height}" viewBox="0 0 ${output.width} ${output.height}"><svg width="${output.width}" height="${output.height}" viewBox="0 0 ${size.width} ${size.height}" preserveAspectRatio="xMidYMid meet"><foreignObject width="${size.width}" height="${size.height}">${content}</foreignObject></svg></svg>`;
    if (new TextEncoder().encode(svg).byteLength > MAX_SERIALIZED_BYTES) throw failure();
    assertCurrent();
    const png = await rasterizeSvgToPng({ svg, ...output, background, signal });
    assertCurrent();
    return png;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    // Never expose source text, resource URLs or browser diagnostics through a
    // menu error. Same-origin Full access is not converted into a new capability.
    void error;
    throw failure();
  }
}
