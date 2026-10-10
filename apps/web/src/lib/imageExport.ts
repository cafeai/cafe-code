import { MAX_PNG_BYTES, MAX_PNG_DIMENSION, MAX_PNG_PIXELS } from "@cafecode/contracts";

import type { MermaidResult } from "./mermaid/renderService";
import { sanitizeMermaidSvg } from "./mermaid/sanitizeSvg";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_EXPORT_SOURCE_BYTES = 8 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 15_000;
const EXPORT_FAILURE = "This image could not be exported.";
const SVG_ELEMENTS = new Set([
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
  "foreignObject",
]);
const HTML_ELEMENTS = new Set([
  "div",
  "span",
  "style",
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
  "img",
]);

/** Reject resource references independently of the caller's presentation
 * allowlist. Only same-document paints and bounded embedded font bytes exist
 * inside the image document; no network request is an export dependency. */
function admitCss(value: string): void {
  const local = value
    .replace(/url\(\s*["']?#[\w-]+["']?\s*\)/gi, "")
    .replace(/url\("data:(?:font\/woff2|application\/octet-stream);base64,[A-Za-z0-9+/=]+"\)/g, "")
    .replace(/@font-face\b/g, "");
  if (/[\\@]|\/\*|url\s*\(|image\s*\(|image-set\s*\(|expression\s*\(/i.test(local))
    throw new Error(EXPORT_FAILURE);
}

/** General rasterization is still an inert-image boundary, not an arbitrary
 * HTML screenshot facility. Mermaid has its stricter SVG-only admission;
 * table HTML is rebuilt by tableImageExport before this independent check. */
function admitImageDocument(svg: string): Document {
  if (svg.length > MAX_EXPORT_SOURCE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(svg))
    throw new Error(EXPORT_FAILURE);
  if (new TextEncoder().encode(svg).byteLength > MAX_EXPORT_SOURCE_BYTES)
    throw new Error(EXPORT_FAILURE);
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (
    document.querySelector("parsererror") ||
    document.documentElement.localName !== "svg" ||
    document.documentElement.namespaceURI !== SVG_NAMESPACE
  )
    throw new Error(EXPORT_FAILURE);
  if (document.createTreeWalker(document, NodeFilter.SHOW_PROCESSING_INSTRUCTION).nextNode())
    throw new Error(EXPORT_FAILURE);
  const nodes = document.querySelectorAll("*");
  if (nodes.length > 20_010) throw new Error(EXPORT_FAILURE);
  for (const node of nodes) {
    const tags =
      node.namespaceURI === SVG_NAMESPACE
        ? SVG_ELEMENTS
        : node.namespaceURI === HTML_NAMESPACE
          ? HTML_ELEMENTS
          : null;
    if (!tags?.has(node.localName)) throw new Error(EXPORT_FAILURE);
    if (node.localName === "style") admitCss(node.textContent ?? "");
    for (const attribute of node.attributes) {
      const name = attribute.localName.toLowerCase();
      if (
        name.startsWith("on") ||
        ["srcdoc", "formaction", "action", "poster", "srcset", "base"].includes(name)
      )
        throw new Error(EXPORT_FAILURE);
      if (name === "src") {
        if (
          node.namespaceURI !== HTML_NAMESPACE ||
          node.localName !== "img" ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(attribute.value)
        )
          throw new Error(EXPORT_FAILURE);
      } else if (name === "href") {
        if (!/^#[\w-]+$/.test(attribute.value)) throw new Error(EXPORT_FAILURE);
      } else if (name !== "xmlns") admitCss(attribute.value);
    }
  }
  return document;
}

export interface SvgPngInput {
  svg: string;
  width: number;
  height: number;
  background: string;
  signal: AbortSignal;
}

/** Export the complete intrinsic image at natural resolution. Large images
 * are uniformly reduced to the shared bitmap budget, never cropped to the
 * viewport. Allocate only the final bounded canvas, not an intrinsic bitmap. */
export async function rasterizeSvgToPng({
  svg,
  width,
  height,
  background,
  signal,
}: SvgPngInput): Promise<Blob> {
  signal.throwIfAborted();
  if (![width, height].every((value) => Number.isFinite(value) && value >= 1 && value <= 100_016))
    throw new Error(EXPORT_FAILURE);
  const imageDocument = admitImageDocument(svg);
  const scale = Math.min(
    1,
    MAX_PNG_DIMENSION / Math.ceil(width),
    MAX_PNG_DIMENSION / Math.ceil(height),
    Math.sqrt(MAX_PNG_PIXELS / (Math.ceil(width) * Math.ceil(height))),
  );
  const targetWidth = Math.max(1, Math.floor(Math.ceil(width) * scale));
  const targetHeight = Math.max(1, Math.floor(Math.ceil(height) * scale));
  // Bound the SVG image's own viewport before decode as well as the canvas.
  // Keeping the original viewBox preserves full geometry at the final scale;
  // relying only on drawImage's destination could leave a huge intrinsic
  // decoder allocation to browser-specific behavior.
  imageDocument.documentElement.setAttribute("width", String(targetWidth));
  imageDocument.documentElement.setAttribute("height", String(targetHeight));
  // The canvas must include both endpoints even when uniform scaling rounds
  // a very thin image to an integral pixel. Avoid default SVG meet-letterboxing
  // inside that rounded bitmap; distortion is bounded to less than one pixel.
  imageDocument.documentElement.setAttribute("preserveAspectRatio", "none");
  const imageSource = new XMLSerializer().serializeToString(imageDocument.documentElement);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    // An admitted data SVG supports origin-clean foreignObject table images.
    // Blob SVG images containing foreignObject taint Chromium canvas even
    // when their content has no external resources. Nothing is attached live.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(imageSource)}`;
    await new Promise<void>((resolve, reject) => {
      const finish = (failed: boolean) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (failed) reject(new Error(EXPORT_FAILURE));
        else resolve();
      };
      const abort = () => finish(true);
      const timeout = setTimeout(() => finish(true), DECODE_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      void image.decode().then(
        () => finish(false),
        () => finish(true),
      );
    });
    signal.throwIfAborted();
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context || !CSS.supports("color", background)) throw new Error(EXPORT_FAILURE);
    // Explicit opaque themed background makes pasted images readable outside
    // Cafe without changing the chart's admitted colors or custom node fills.
    context.fillStyle = background;
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    signal.throwIfAborted();
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(EXPORT_FAILURE))),
        "image/png",
      );
    });
    signal.throwIfAborted();
    if (png.type !== "image/png" || png.size < 1 || png.size > MAX_PNG_BYTES)
      throw new Error(EXPORT_FAILURE);
    return png;
  } finally {
    image.removeAttribute("src");
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function createMermaidPng(
  result: MermaidResult,
  theme: "dark" | "light",
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  // Do not trust a retained result object as a new resource capability. The
  // existing SVG-only policy remains independently enforced on every export.
  const admitted = sanitizeMermaidSvg(result.svg);
  // Mermaid export may be requested from an explicitly themed saved view,
  // not the document theme. Resolve Cafe's token from the matching theme scope.
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(--background-${theme})`;
  probe.style.display = "none";
  document.body.append(probe);
  const background = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return rasterizeSvgToPng({ ...admitted, background, signal });
}

async function pngBytes(png: Promise<Blob>, signal: AbortSignal): Promise<Uint8Array> {
  const blob = await png;
  signal.throwIfAborted();
  if (blob.type !== "image/png" || blob.size < 1 || blob.size > MAX_PNG_BYTES)
    throw new Error(EXPORT_FAILURE);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  return bytes;
}

/** Invoke the browser clipboard during the original menu gesture. Waiting
 * for rasterization before ClipboardItem/write loses Safari user activation.
 * The promised blob is fenced before admission; never fall back to text. */
export async function copyPngToClipboard(png: Promise<Blob>, signal: AbortSignal): Promise<void> {
  if (window.desktopBridge) {
    const bytes = await pngBytes(png, signal);
    signal.throwIfAborted();
    await window.desktopBridge.copyPng(bytes);
    return;
  }
  // Observe the promise even on unsupported clients; no detached rejection.
  void png.catch(() => undefined);
  signal.throwIfAborted();
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("Image clipboard unavailable.");
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": png.then((blob) => {
        signal.throwIfAborted();
        if (blob.type !== "image/png" || blob.size < 1 || blob.size > MAX_PNG_BYTES)
          throw new Error(EXPORT_FAILURE);
        return blob;
      }),
    }),
  ]);
}

export async function savePngToDisk(
  png: Promise<Blob>,
  suggestedName: string,
  signal: AbortSignal,
): Promise<"saved" | "cancelled"> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.png$/.test(suggestedName))
    throw new Error(EXPORT_FAILURE);
  if (window.desktopBridge) {
    const bytes = await pngBytes(png, signal);
    signal.throwIfAborted();
    const result = await window.desktopBridge.savePng({
      png: bytes,
      suggestedName,
    });
    if (result === "failed") throw new Error(EXPORT_FAILURE);
    return result;
  }
  const blob = await png;
  signal.throwIfAborted();
  if (blob.type !== "image/png" || blob.size < 1 || blob.size > MAX_PNG_BYTES)
    throw new Error(EXPORT_FAILURE);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = suggestedName;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Download dispatch is not a disk-write receipt. Retain the URL only for
    // the bounded browser download handoff, then release the snapshot bytes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return "saved";
}
