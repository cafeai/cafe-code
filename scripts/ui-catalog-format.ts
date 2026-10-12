import { format, type FormatConfig } from "oxfmt";

export type GeneratedCatalogFilename = "en.json" | "messages.json";

// These are the repository's current default JSON style. Keep generation and
// the existing oxfmt CLI on one formatter; raw JSON.stringify bytes are not a
// formatting contract, particularly for grouped location arrays. Formatting
// accepts only source text and never reads, imports or publishes an output.
const CATALOG_JSON_STYLE = {
  printWidth: 100,
  endOfLine: "lf",
  tabWidth: 2,
  useTabs: false,
  insertFinalNewline: true,
} satisfies FormatConfig;

/** Prepare an exact generated catalog without changing any key, ICU source,
 * context, location or order. All parser/native formatter failures are reduced
 * to a content-free reason: errors/codeframes may contain supplied text. The
 * runner must prepare both catalogs before it publishes any of its outputs. */
export async function formatGeneratedCatalogJson(
  filename: GeneratedCatalogFilename,
  sourceText: string,
): Promise<string> {
  try {
    if (filename !== "en.json" && filename !== "messages.json")
      throw new Error("unapproved generated output");
    const source: unknown = JSON.parse(sourceText);
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw new Error("generated catalog object required");
    const result = await format(filename, sourceText, CATALOG_JSON_STYLE);
    if (result.errors.length || typeof result.code !== "string")
      throw new Error("generated catalog formatter reported an error");
    const formatted: unknown = JSON.parse(result.code);
    if (JSON.stringify(source) !== JSON.stringify(formatted))
      throw new Error("generated catalog formatting changed JSON semantics");
    return result.code;
  } catch {
    throw new Error("generated catalog JSON formatting failed");
  }
}
