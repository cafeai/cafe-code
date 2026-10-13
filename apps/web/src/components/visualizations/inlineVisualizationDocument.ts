import type { VisualizationHostPresentation } from "@cafecode/contracts/visualizationHost";
import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const INLINE_VISUALIZATION_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const PRESENTATION_COLORS = {
  background: "--background",
  foreground: "--foreground",
  muted: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  chart6: "--chart-6",
} as const;
export function inlineVisualizationColors(
  presentation: VisualizationHostPresentation,
): readonly (readonly [string, string])[] {
  return (Object.keys(PRESENTATION_COLORS) as (keyof typeof PRESENTATION_COLORS)[]).map(
    (key) => [PRESENTATION_COLORS[key], presentation.colors[key]] as const,
  );
}

/** Find only actual document tags with a finite lexical pass. Quoted tag text,
 * comments and raw-text scripts/styles must not be mistaken for a real head.
 * This is composition, not sanitization: authorized source remains executable. */
function documentInsertion(html: string): { index: number; missingHead: boolean } | null {
  const lower = html.toLowerCase();
  const rawText = new Set([
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
  ]);
  let position = 0,
    rootEnd = -1,
    templates = 0,
    tags = 0;
  while (position < html.length && ++tags <= 100_000) {
    const start = html.indexOf("<", position);
    if (start < 0) break;
    if (lower.startsWith("<!--", start)) {
      const end = lower.indexOf("-->", start + 4);
      if (end < 0) break;
      position = end + 3;
      continue;
    }
    let cursor = start + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor++;
    const nameStart = cursor;
    while (cursor < html.length && /[a-zA-Z0-9:-]/.test(html[cursor]!)) cursor++;
    const name = lower.slice(nameStart, cursor);
    let quote: string | undefined;
    while (cursor < html.length) {
      const character = html[cursor++]!;
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    position = cursor;
    // Raw-text bodies remain raw even inside a template. Looking for template
    // end tags before skipping a script's text would treat a JavaScript string
    // such as "</template><html><head>" as real document structure and splice
    // the prelude into the string instead of the actual document head.
    if (!closing && name === "plaintext") break;
    if (!closing && rawText.has(name)) {
      let end = lower.indexOf(`</${name}`, cursor);
      while (end >= 0 && !/[\s/>]/.test(lower[end + name.length + 2] ?? ">"))
        end = lower.indexOf(`</${name}`, end + 2);
      if (end < 0) break;
      position = end;
    }
    if (name === "template") templates += closing ? -1 : 1;
    if (templates > 0) continue;
    templates = Math.max(0, templates);
    if (!closing && name === "html" && rootEnd < 0) rootEnd = cursor;
    else if (!closing && name === "head" && rootEnd >= 0)
      return { index: cursor, missingHead: false };
    else if (!closing && name === "body" && rootEnd >= 0)
      return { index: rootEnd, missingHead: true };
  }
  return rootEnd >= 0 ? { index: rootEnd, missingHead: true } : null;
}

/** This is a best-effort offline policy for an explicitly Full-access,
 * same-origin unsandboxed document. It cannot prevent that document from using
 * its parent's authority. No sandbox, renderer separation or containment claim
 * is made by this wrapper, even though source stays out of parent DOM injection. */
export function createInlineVisualizationDocument(
  html: string,
  presentation: VisualizationHostPresentation,
  dark: boolean,
  frameId: string,
  generated = true,
) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(frameId))
    throw new Error("visualization-frame-invalid");
  // The generated-source transport registers these exact fixed offline faces
  // as a prefix. A style before an authored doctype would force quirks mode and
  // discard its head attributes. Relocate only the complete committed prefix
  // into the real head, before author scripts; never scan/remove received CSS
  // or change immutable stored source, portable exports, or external Apps.
  const fixedFonts =
    generated && html.startsWith(GENERATED_VISUALIZATION_FONT_APPENDIX)
      ? GENERATED_VISUALIZATION_FONT_APPENDIX
      : "";
  const source = fixedFonts ? html.slice(fixedFonts.length) : html;
  const tooltipStyle = generated
    ? '[role="tooltip"],[data-cafe-tooltip]{background:var(--background)!important;color:var(--foreground)!important;border:1px solid color-mix(in srgb,var(--foreground) 18%,transparent)!important;color-scheme:inherit}'
    : "";
  const metadata = JSON.stringify({
    frameId,
    locale: presentation.locale,
    reducedMotion: presentation.reducedMotion,
    scale: presentation.scale,
    dark,
    colors: inlineVisualizationColors(presentation),
  }).replace(/[<>&]/g, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const initialize = `<script>(()=>{const value=${metadata};const root=document.documentElement;root.classList.toggle("dark",value.dark);root.lang=value.locale;root.dataset.cafeInlineFrame=value.frameId;root.dataset.cafeVisible="true";root.dataset.cafePresentationVisible="true";root.dataset.cafeReducedMotion=String(value.reducedMotion);root.style.colorScheme=value.dark?"dark":"light";root.style.setProperty("--cafe-interface-scale",String(value.scale));for(const [name,color]of value.colors)root.style.setProperty(name,color);})();</script>`;
  const prelude = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${INLINE_VISUALIZATION_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%!important;max-width:100%!important;min-width:0!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:hidden!important}html{background:transparent;color:var(--foreground);font-size:calc(14px * var(--cafe-interface-scale));--font-sans:'DM Sans Variable',ui-sans-serif,system-ui,sans-serif}body{font-family:var(--font-sans)}*,*:before,*:after{box-sizing:border-box}svg,canvas,img{max-width:100%}pre,code,kbd,samp{font-family:ui-monospace,monospace}${tooltipStyle}</style>${fixedFonts}${initialize}`;
  const insertion = documentInsertion(source);
  // Keep the authored root/head/body attributes, style variables and node order
  // of a full document. A second outer html/body silently discards those root
  // attributes and breaks existing dashboards despite successful publication.
  const document = insertion
    ? source.slice(0, insertion.index) +
      (insertion.missingHead ? "<head>" : "") +
      prelude +
      (insertion.missingHead ? "</head>" : "") +
      source.slice(insertion.index)
    : `<!doctype html><html><head>${prelude}</head><body>${source}</body></html>`;
  if (new TextEncoder().encode(document).byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("visualization-document-too-large");
  return document;
}

/** Natural flow excludes the previous frame viewport's scrollHeight/min-height
 * and fixed decoration. This finite descendant measurement cannot authorize
 * parent actions, expand work with history, or promise to repair arbitrary HTML. */
export function measureInlineVisualization(
  document: Document,
): { height: number; constrained: boolean } | null {
  const body = document.body,
    view = document.defaultView;
  if (!body || !view) return null;
  const top = body.getBoundingClientRect().top;
  const padding = Number.parseFloat(view.getComputedStyle(body).paddingBottom) || 0;
  if (!Number.isFinite(top) || !Number.isFinite(padding) || padding < 0) return null;
  let height = 0,
    count = 0,
    depth = 1;
  let node: Node | null = body.firstChild;
  while (node) {
    if (++count > 20_000 || depth > 100) return { height: 2000, constrained: true };
    let bottom = top,
      margin = 0,
      descend = true;
    if (node.nodeType === 1) {
      const element = node as Element,
        style = view.getComputedStyle(element);
      if (style.display === "none" || style.position === "fixed" || style.position === "absolute")
        descend = false;
      else {
        bottom = element.getBoundingClientRect().bottom;
        margin = Number.parseFloat(style.marginBottom) || 0;
        // SVG coordinates are paint within its own viewport, not root HTML flow.
        // The SVG/canvas box counts, but its vector/fallback subtree does not.
        if (element.namespaceURI === "http://www.w3.org/2000/svg" || element.localName === "canvas")
          descend = false;
      }
    } else if (node.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(node);
      bottom = range.getBoundingClientRect().bottom;
    } else descend = false;
    if (!Number.isFinite(bottom) || !Number.isFinite(margin)) return null;
    height = Math.max(height, bottom - top + Math.max(0, margin));
    if (descend && node.firstChild) {
      node = node.firstChild;
      depth++;
      continue;
    }
    while (node && !node.nextSibling && node.parentNode !== body) {
      node = node.parentNode;
      depth--;
    }
    node = node?.nextSibling ?? null;
  }
  const natural = Math.ceil(height + padding);
  if (!Number.isSafeInteger(natural) || natural < 0) return null;
  return { height: Math.max(80, Math.min(2000, natural)), constrained: natural > 2000 };
}
