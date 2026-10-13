import type { VisualizationHostDocument } from "@cafecode/contracts/visualizationHost";
import { visualizationFluidScript } from "@cafecode/shared/visualizationFluidRuntime";
import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";

const MAX_PORTABLE_HTML_BYTES = 16 * 1024 * 1024;
const space = (character: string | undefined) =>
  character !== undefined && " \t\n\r\f".includes(character);
const urlAttributes = new Set(["src", "href", "poster"]);

/** A bounded, non-evaluating rewriter for the declared static raster spelling.
 * It does not pretend to compile JavaScript, CSS, srcset or dynamic URLs. Those
 * must be self-contained in the authored page. Exported executable HTML runs
 * outside Cafe's network/sandbox policy after explicit user disclosure. */
export function embedStaticVisualizationAssets(
  source: string,
  assets: VisualizationHostDocument["assets"],
): string {
  return embedStaticAssets(source, assets, MAX_PORTABLE_HTML_BYTES).html;
}

/** Explicit generated exports are derived executable documents, not a rewrite
 * of private source or its commitment. Every generated export receives the
 * actual fixed offline chat faces and their complete OFL; only a statically
 * authored fluid canvas opts into the same fixed licensed fluid helper. Append
 * these after authored content, preserving the original
 * doctype, comments and raw-text bytes. This does not compile dynamic markup.
 * Without Cafe's native presentation hint it renders only its bounded static
 * initial frame; no native bootstrap, permission or live lease is exported. */
export function exportGeneratedVisualizationHtml(
  source: string,
  assets: VisualizationHostDocument["assets"],
): string {
  // Reuse the bounded tokenizer without asset replacements to distinguish a
  // real start-tag attribute from marker-like comments, scripts or quoted text.
  // This presentation opt-in is never an authorization or source commitment.
  const scanned = embedStaticAssets(source, [], MAX_PORTABLE_HTML_BYTES);
  const appendix =
    GENERATED_VISUALIZATION_FONT_APPENDIX +
    (scanned.hasFluidMarker ? `\n${visualizationFluidScript("generated")}` : "");
  const appendixBytes = Buffer.byteLength(appendix, "utf8");
  const { html } = embedStaticAssets(source, assets, MAX_PORTABLE_HTML_BYTES - appendixBytes);
  // Reserve actual font/license plus optional helper bytes before every asset
  // replacement and chunk join, so final concatenation remains within 16 MiB.
  // Private source, commitments, assets and admission receipts are unchanged.
  return html + appendix;
}

function embedStaticAssets(
  source: string,
  assets: VisualizationHostDocument["assets"],
  maxOutputBytes: number,
): { html: string; hasFluidMarker: boolean } {
  let outputBytes = Buffer.byteLength(source, "utf8");
  if (outputBytes > maxOutputBytes)
    throw new Error("Portable visualization export is unavailable.");
  const replacements = new Map(
    assets.map((asset) => [`asset/${asset.id}`, `data:${asset.mime};base64,${asset.base64}`]),
  );
  const lower = source.toLowerCase();
  const chunks: string[] = [];
  let copied = 0;
  let position = 0;
  let tokens = 0;
  let hasFluidMarker = false;
  while (position < source.length) {
    if (++tokens > 16384) throw new Error("Portable visualization export is unavailable.");
    const start = source.indexOf("<", position);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      position = end < 0 ? source.length : end + 3;
      continue;
    }
    let cursor = start + 1;
    if (source[cursor] === "/" || source[cursor] === "!" || source[cursor] === "?") {
      position = source.indexOf(">", cursor) + 1;
      if (position === 0) break;
      continue;
    }
    const nameStart = cursor;
    while (cursor < source.length && /[a-zA-Z0-9:-]/.test(source[cursor]!)) cursor++;
    const tag = lower.slice(nameStart, cursor);
    if (!tag || cursor === nameStart) {
      position = start + 1;
      continue;
    }
    let complete = false;
    let tagHasFluidMarker = false;
    while (cursor < source.length) {
      if (++tokens > 16384) throw new Error("Portable visualization export is unavailable.");
      while (space(source[cursor])) cursor++;
      if (source[cursor] === ">") {
        cursor++;
        complete = true;
        break;
      }
      if (source[cursor] === "/" && source[cursor + 1] === ">") {
        cursor += 2;
        complete = true;
        break;
      }
      const attributeStart = cursor;
      while (
        cursor < source.length &&
        !space(source[cursor]) &&
        !"=/>\"'".includes(source[cursor]!)
      )
        cursor++;
      if (cursor === attributeStart) {
        cursor++;
        continue;
      }
      const attribute = lower.slice(attributeStart, cursor);
      if (tag === "canvas" && attribute === "data-cafe-fluid") tagHasFluidMarker = true;
      while (space(source[cursor])) cursor++;
      if (source[cursor] !== "=") continue;
      cursor++;
      while (space(source[cursor])) cursor++;
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor++] : undefined;
      const valueStart = cursor;
      if (quote) {
        const end = source.indexOf(quote, cursor);
        if (end < 0) {
          cursor = source.length;
          break;
        }
        cursor = end;
      } else
        while (cursor < source.length && !space(source[cursor]) && source[cursor] !== ">") cursor++;
      const valueEnd = cursor;
      const replacement = urlAttributes.has(attribute)
        ? replacements.get(source.slice(valueStart, valueEnd))
        : undefined;
      if (replacement) {
        outputBytes += Buffer.byteLength(replacement, "utf8") - (valueEnd - valueStart);
        if (outputBytes > maxOutputBytes)
          throw new Error("Portable visualization export is unavailable.");
        chunks.push(source.slice(copied, valueStart), replacement);
        copied = valueEnd;
      }
      if (quote) cursor++;
    }
    position = cursor;
    if (complete && tagHasFluidMarker) hasFluidMarker = true;
    if (
      complete &&
      ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"].includes(tag)
    ) {
      let close = lower.indexOf(`</${tag}`, position);
      while (
        close >= 0 &&
        !(
          space(source[close + tag.length + 2]) ||
          source[close + tag.length + 2] === ">" ||
          source[close + tag.length + 2] === "/"
        )
      )
        close = lower.indexOf(`</${tag}`, close + tag.length + 2);
      position = close < 0 ? source.length : close;
    }
    if (tag === "plaintext") break;
  }
  // The marker-only pass and no-replacement exports return the exact original
  // string without constructing a second source-sized chunk join.
  if (copied === 0) return { html: source, hasFluidMarker };
  chunks.push(source.slice(copied));
  return { html: chunks.join(""), hasFluidMarker };
}
