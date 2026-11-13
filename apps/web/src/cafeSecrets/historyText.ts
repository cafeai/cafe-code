import { findCafeSecretReferenceRanges } from "@cafecode/shared/cafeSecrets";

/** Presentation only: never put this result in messages, drafts or dispatch. */
export function cafeSecretHistoryText(text: string, values: ReadonlyMap<string, string>): string {
  let result = "";
  let cursor = 0;
  // A repeated short reference must not multiply a 16 KiB value into hundreds
  // of MiB of DOM text. Preserve all source text and leave excess references.
  let expansionBudget = Math.max(0, 1_048_576 - text.length);
  for (const range of findCafeSecretReferenceRanges(text)) {
    const value = values.get(range.id);
    if (value === undefined) continue;
    const marker = `[sec:${value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}]`;
    const expansion = marker.length - (range.end - range.start);
    if (expansion > expansionBudget) continue;
    expansionBudget -= expansion;
    result += text.slice(cursor, range.start);
    result += marker;
    cursor = range.end;
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}
