import type { VisualizationHostDocument } from "@cafecode/contracts/visualizationHost";

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
  const replacements = new Map(
    assets.map((asset) => [`asset/${asset.id}`, `data:${asset.mime};base64,${asset.base64}`]),
  );
  const lower = source.toLowerCase();
  const chunks: string[] = [];
  let copied = 0;
  let position = 0;
  let outputBytes = Buffer.byteLength(source, "utf8");
  let tokens = 0;
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
        if (outputBytes > 16 * 1024 * 1024)
          throw new Error("Portable visualization export is unavailable.");
        chunks.push(source.slice(copied, valueStart), replacement);
        copied = valueEnd;
      }
      if (quote) cursor++;
    }
    position = cursor;
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
  chunks.push(source.slice(copied));
  return chunks.join("");
}
