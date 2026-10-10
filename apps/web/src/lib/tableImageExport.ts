import dmSansNormal from "@fontsource-variable/dm-sans/files/dm-sans-latin-opsz-normal.woff2?inline";
import dmSansExtendedNormal from "@fontsource-variable/dm-sans/files/dm-sans-latin-ext-opsz-normal.woff2?inline";
import dmSansItalic from "@fontsource-variable/dm-sans/files/dm-sans-latin-opsz-italic.woff2?inline";
import dmSansExtendedItalic from "@fontsource-variable/dm-sans/files/dm-sans-latin-ext-opsz-italic.woff2?inline";
import katexAms from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline";
import katexCaligraphic from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline";
import katexCaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline";
import katexFraktur from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline";
import katexFrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline";
import katexMain from "katex/dist/fonts/KaTeX_Main-Regular.woff2?inline";
import katexMainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?inline";
import katexMainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?inline";
import katexMainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline";
import katexMathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?inline";
import katexMathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline";
import katexSansSerif from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline";
import katexSansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline";
import katexSansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline";
import katexScript from "katex/dist/fonts/KaTeX_Script-Regular.woff2?inline";
import katexSize1 from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline";
import katexSize2 from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline";
import katexSize3 from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline";
import katexSize4 from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline";
import katexTypewriter from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline";

import { rasterizeSvgToPng } from "./imageExport";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_SOURCE_NODES = 20_000;
const MAX_SOURCE_TEXT = 1_000_000;
const MAX_SOURCE_DIMENSION = 100_000;
const MAX_SERIALIZED_CHARACTERS = 8 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_PIXELS = 4_194_304;
const MAX_SOURCE_IMAGES = 256;
const MAX_EMBEDDED_IMAGE_CHARACTERS = 4 * 1024 * 1024;
const EXPORT_PADDING = 8;
const TABLE_EXPORT_FAILURE = "This table could not be exported as an image.";

// Rebuild only the presentation vocabulary emitted by Markdown and untrusted
// KaTeX. Never clone a live tree: assigning an img src during cloning can begin
// another request even while the new element is detached from the document.
const HTML_ELEMENTS = new Set([
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
  "span",
  "div",
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
  "a",
  "small",
  "sub",
  "sup",
  "mark",
  "abbr",
  "kbd",
  "samp",
  "var",
]);
const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
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
  "width",
  "height",
  "rx",
  "ry",
  "cx",
  "cy",
  "r",
  "points",
  "fill-rule",
]);

// Computed CSS resolves theme variables, rem sizes, relative KaTeX offsets and
// text colors before serialization. This list deliberately excludes resource
// properties, filters, animation, custom properties and arbitrary authored CSS.
const PRESENTATION_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
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
  "opacity",
  "visibility",
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
  "justify-content",
  "gap",
  "row-gap",
  "column-gap",
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
] as const;

interface EmbeddedFont {
  family: string;
  source: string;
  weight: string;
  style: "normal" | "italic";
  unicodeRange?: string;
}

const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const EXTENDED_RANGE =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const EMBEDDED_FONTS: readonly EmbeddedFont[] = [
  {
    family: "DM Sans Variable",
    source: dmSansNormal,
    weight: "100 1000",
    style: "normal",
    unicodeRange: LATIN_RANGE,
  },
  {
    family: "DM Sans Variable",
    source: dmSansExtendedNormal,
    weight: "100 1000",
    style: "normal",
    unicodeRange: EXTENDED_RANGE,
  },
  {
    family: "DM Sans Variable",
    source: dmSansItalic,
    weight: "100 1000",
    style: "italic",
    unicodeRange: LATIN_RANGE,
  },
  {
    family: "DM Sans Variable",
    source: dmSansExtendedItalic,
    weight: "100 1000",
    style: "italic",
    unicodeRange: EXTENDED_RANGE,
  },
  { family: "KaTeX_AMS", source: katexAms, weight: "400", style: "normal" },
  { family: "KaTeX_Caligraphic", source: katexCaligraphic, weight: "400", style: "normal" },
  { family: "KaTeX_Caligraphic", source: katexCaligraphicBold, weight: "700", style: "normal" },
  { family: "KaTeX_Fraktur", source: katexFraktur, weight: "400", style: "normal" },
  { family: "KaTeX_Fraktur", source: katexFrakturBold, weight: "700", style: "normal" },
  { family: "KaTeX_Main", source: katexMain, weight: "400", style: "normal" },
  { family: "KaTeX_Main", source: katexMainBold, weight: "700", style: "normal" },
  { family: "KaTeX_Main", source: katexMainItalic, weight: "400", style: "italic" },
  { family: "KaTeX_Main", source: katexMainBoldItalic, weight: "700", style: "italic" },
  { family: "KaTeX_Math", source: katexMathItalic, weight: "400", style: "italic" },
  { family: "KaTeX_Math", source: katexMathBoldItalic, weight: "700", style: "italic" },
  { family: "KaTeX_SansSerif", source: katexSansSerif, weight: "400", style: "normal" },
  { family: "KaTeX_SansSerif", source: katexSansSerifBold, weight: "700", style: "normal" },
  { family: "KaTeX_SansSerif", source: katexSansSerifItalic, weight: "400", style: "italic" },
  { family: "KaTeX_Script", source: katexScript, weight: "400", style: "normal" },
  { family: "KaTeX_Size1", source: katexSize1, weight: "400", style: "normal" },
  { family: "KaTeX_Size2", source: katexSize2, weight: "400", style: "normal" },
  { family: "KaTeX_Size3", source: katexSize3, weight: "400", style: "normal" },
  { family: "KaTeX_Size4", source: katexSize4, weight: "400", style: "normal" },
  { family: "KaTeX_Typewriter", source: katexTypewriter, weight: "400", style: "normal" },
];

interface SnapshotBudget {
  nodes: number;
  text: number;
  presentation: number;
  images: number;
  imagePixels: number;
  imageCharacters: number;
  families: Set<string>;
}

export interface TableExportSvg {
  svg: string;
  width: number;
  height: number;
  background: string;
}

function rejectExport(): never {
  throw new Error(TABLE_EXPORT_FAILURE);
}

function copyPresentation(
  source: Element,
  target: HTMLElement | SVGElement,
  budget: SnapshotBudget,
) {
  const style = getComputedStyle(source);
  for (const property of PRESENTATION_PROPERTIES) {
    const value = style.getPropertyValue(property);
    // CSSOM returns parsed computed values. Still reject references and CSS
    // escapes rather than trusting a future addition to this property list.
    budget.presentation += property.length + value.length + 2;
    if (
      value.length > 100_000 ||
      budget.presentation > MAX_SERIALIZED_CHARACTERS ||
      /url\s*\(|image-set\s*\(|expression\s*\(|@import|[\\<>]/i.test(value)
    )
      rejectExport();
    if (value) target.style.setProperty(property, value);
  }
  for (const font of EMBEDDED_FONTS) {
    if (style.fontFamily.includes(font.family)) budget.families.add(font.family);
  }
}

function decorativeIconFallback(
  source: HTMLImageElement,
  budget: SnapshotBudget,
): SVGSVGElement | null {
  const kind = source.dataset.cafeImageExportFallback;
  if (
    (kind !== "file" && kind !== "directory") ||
    source.alt !== "" ||
    source.getAttribute("aria-hidden") !== "true" ||
    !source.classList.contains("chat-markdown-file-link-icon") ||
    !source.closest("a.chat-markdown-file-link")
  )
    return null;
  // The app deliberately labels these decorative file-link icons. Its CDN
  // image can be unready or unreadable to canvas, so use the same local Lucide
  // fallback vocabulary as VscodeEntryIcon instead of making the full link
  // table unavailable. This never substitutes an arbitrary authored image.
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  copyPresentation(source, icon, budget);
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.style.fill = "none";
  icon.style.stroke = "currentColor";
  icon.style.strokeWidth = "2";
  icon.style.strokeLinecap = "round";
  icon.style.strokeLinejoin = "round";
  // Geometry is from the repository-pinned Lucide 1.48.0 File/Folder icons.
  const paths =
    kind === "directory"
      ? [
          "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
        ]
      : [
          "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
          "M14 2v5a1 1 0 0 0 1 1h5",
        ];
  for (const geometry of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", geometry);
    icon.append(path);
  }
  return icon;
}

function snapshotImage(
  source: HTMLImageElement,
  budget: SnapshotBudget,
): HTMLImageElement | SVGSVGElement {
  // Reuse only decoded pixels already held by the source document. Drawing an
  // unreadable cross-origin image taints this private canvas; toDataURL then
  // refuses it, and no unfinished/cross-origin image can enter the export.
  const width = source.naturalWidth;
  const height = source.naturalHeight;
  budget.images += 1;
  budget.imagePixels += width * height;
  if (budget.images > MAX_SOURCE_IMAGES || budget.imagePixels > MAX_EMBEDDED_IMAGE_PIXELS)
    rejectExport();
  if (!source.complete || width < 1 || height < 1)
    return decorativeIconFallback(source, budget) ?? rejectExport();
  if (width * height > MAX_EMBEDDED_IMAGE_PIXELS) rejectExport();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let data: string;
  try {
    const context = canvas.getContext("2d");
    if (!context) rejectExport();
    context.drawImage(source, 0, 0);
    data = canvas.toDataURL("image/png");
  } catch {
    return decorativeIconFallback(source, budget) ?? rejectExport();
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  // Limits and presentation admission failures are never converted into an
  // icon fallback. Only decoding/canvas unreadability permits that exception.
  budget.imageCharacters += data.length;
  if (
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data) ||
    budget.imageCharacters > MAX_EMBEDDED_IMAGE_CHARACTERS
  )
    rejectExport();
  const image = document.createElement("img");
  image.src = data;
  copyPresentation(source, image, budget);
  return image;
}

function snapshotNode(source: Node, budget: SnapshotBudget, depth = 0): Node | null {
  if (++budget.nodes > MAX_SOURCE_NODES || depth > 100) rejectExport();
  if (source.nodeType === Node.TEXT_NODE) {
    const value = source.textContent ?? "";
    budget.text += value.length;
    if (budget.text > MAX_SOURCE_TEXT) rejectExport();
    return document.createTextNode(value);
  }
  if (!(source instanceof Element)) return null;
  // KaTeX's MathML copy is accessibility-only, clipped to a one-pixel box.
  // The complete visible formula is copied from its accompanying HTML tree.
  if (source.classList.contains("katex-mathml")) return null;
  for (const pseudo of ["::before", "::after"]) {
    const content = getComputedStyle(source, pseudo).content;
    // Automatic equation numbers or other generated content are not DOM text.
    // Refuse a partial image rather than silently omit visible pseudo content.
    if (content !== "none" && content !== "normal" && content !== '""') rejectExport();
  }
  if (source instanceof HTMLImageElement) return snapshotImage(source, budget);

  const tag = source.localName;
  const isSvg = source.namespaceURI === SVG_NAMESPACE;
  if (!(isSvg ? SVG_ELEMENTS : HTML_ELEMENTS).has(tag)) rejectExport();
  const target = document.createElementNS(isSvg ? SVG_NAMESPACE : HTML_NAMESPACE, tag) as
    | HTMLElement
    | SVGElement;
  copyPresentation(source, target, budget);
  if (isSvg) {
    for (const attribute of source.attributes) {
      if (!SVG_ATTRIBUTES.has(attribute.name)) continue;
      budget.presentation += attribute.name.length + attribute.value.length + 3;
      if (attribute.value.length > 100_000 || /url\s*\(|[\\<>]/i.test(attribute.value))
        rejectExport();
      if (budget.presentation > MAX_SERIALIZED_CHARACTERS) rejectExport();
      target.setAttribute(attribute.name, attribute.value);
    }
  } else if (tag === "td" || tag === "th" || tag === "col") {
    for (const name of ["colspan", "rowspan", "span"]) {
      const value = source.getAttribute(name);
      if (value && /^[1-9]\d{0,3}$/.test(value)) target.setAttribute(name, value);
    }
  }
  // Inert anchors retain their exact visible label and styling without any
  // URL, handler, tooltip, file action, identifier or capability metadata.
  for (const child of source.childNodes) {
    const copy = snapshotNode(child, budget, depth + 1);
    if (copy) target.append(copy);
  }
  return target;
}

/** Capture a complete, resource-free presentation snapshot synchronously.
 * The caller's lifecycle token governs later rasterization/publication; this
 * snapshot never mutates the live table or its scroll/zoom state. */
export function buildTableExportSvg(source: HTMLTableElement): TableExportSvg {
  if (!source.isConnected) rejectExport();
  const sourceStyle = getComputedStyle(source);
  // offset/scroll metrics round to integral pixels. Rounding a fractional table
  // width down can rewrap its final column, causing rows to grow and then be
  // clipped by the original height. Computed used dimensions preserve those
  // fractions without inheriting any ancestor's zoom transform or scrolling.
  const borderBoxExtent = (dimension: "width" | "height"): number => {
    const used = Number.parseFloat(sourceStyle.getPropertyValue(dimension));
    if (!Number.isFinite(used)) return 0;
    if (sourceStyle.boxSizing === "border-box") return used;
    const edges = dimension === "width" ? ["left", "right"] : ["top", "bottom"];
    return edges.reduce(
      (extent, edge) =>
        extent +
        (Number.parseFloat(sourceStyle.getPropertyValue(`padding-${edge}`)) || 0) +
        (Number.parseFloat(sourceStyle.getPropertyValue(`border-${edge}-width`)) || 0),
      used,
    );
  };
  const tableWidth = Math.ceil(
    Math.max(source.offsetWidth, source.scrollWidth, borderBoxExtent("width")),
  );
  const tableHeight = Math.ceil(
    Math.max(source.offsetHeight, source.scrollHeight, borderBoxExtent("height")),
  );
  if (
    tableWidth < 1 ||
    tableHeight < 1 ||
    tableWidth > MAX_SOURCE_DIMENSION ||
    tableHeight > MAX_SOURCE_DIMENSION
  )
    rejectExport();
  const budget: SnapshotBudget = {
    nodes: 0,
    text: 0,
    presentation: 0,
    images: 0,
    imagePixels: 0,
    imageCharacters: 0,
    families: new Set(),
  };
  const table = snapshotNode(source, budget) as HTMLTableElement;
  // Source layout dimensions ignore ancestor scaling and scroll offsets. Give
  // the frozen table its full extent instead of a percentage of the viewport.
  table.style.position = "static";
  table.style.width = `${tableWidth}px`;
  table.style.height = `${tableHeight}px`;
  table.style.minWidth = "0";
  table.style.maxWidth = "none";
  table.style.margin = "0";
  table.style.overflow = "visible";

  const background = sourceStyle.getPropertyValue("--background").trim();
  const body = document.createElementNS(HTML_NAMESPACE, "div");
  body.style.cssText = `width:${tableWidth + EXPORT_PADDING * 2}px;height:${tableHeight + EXPORT_PADDING * 2}px;padding:${EXPORT_PADDING}px;box-sizing:border-box;overflow:hidden;`;
  // Resolve token colors through CSSOM, including oklch/color-mix definitions,
  // rather than accepting raw custom-property text into the SVG stylesheet.
  body.style.backgroundColor = background;
  if (!body.style.backgroundColor) rejectExport();
  const fonts = document.createElementNS(HTML_NAMESPACE, "style");
  fonts.textContent = EMBEDDED_FONTS.filter((font) => budget.families.has(font.family))
    .map((font) => {
      if (
        !/^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/.test(font.source) &&
        !/^data:application\/octet-stream;base64,[A-Za-z0-9+/=]+$/.test(font.source)
      )
        rejectExport();
      return `@font-face{font-family:"${font.family}";font-style:${font.style};font-weight:${font.weight};src:url("${font.source}") format("woff2");${font.unicodeRange ? `unicode-range:${font.unicodeRange};` : ""}}`;
    })
    .join("");
  body.append(fonts, table);
  const width = tableWidth + EXPORT_PADDING * 2;
  const height = tableHeight + EXPORT_PADDING * 2;
  const svg = `<svg xmlns="${SVG_NAMESPACE}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}">${new XMLSerializer().serializeToString(body)}</foreignObject></svg>`;
  if (svg.length > MAX_SERIALIZED_CHARACTERS) rejectExport();
  return { svg, width, height, background: body.style.backgroundColor };
}

export async function createTablePng(source: HTMLTableElement, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  // Browser text metrics can change once the bundled typefaces finish loading.
  // Wait before measuring so the PNG uses the same complete font layout the
  // user sees, while keeping a cancelled/retired action responsive.
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(new DOMException("Image export cancelled.", "AbortError"));
    const timeout = setTimeout(() => finish(new Error(TABLE_EXPORT_FAILURE)), 15_000);
    signal.addEventListener("abort", aborted, { once: true });
    void document.fonts.ready.then(
      () => finish(),
      () => finish(new Error(TABLE_EXPORT_FAILURE)),
    );
  });
  signal.throwIfAborted();
  const snapshot = buildTableExportSvg(source);
  signal.throwIfAborted();
  return rasterizeSvgToPng({ ...snapshot, signal });
}
