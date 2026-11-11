import { findCafeSecretRanges } from "@cafecode/shared/cafeSecrets";

/**
 * Remove every complete or incomplete unescaped secret marker before a draft
 * reaches browser storage. Removed (not masked) so a reload can never send a
 * placeholder as a new secret value.
 */
export function redactCafeSecretsForPersistence(text: string): string {
  const ranges = findCafeSecretRanges(text);
  if (ranges.length === 0) return text;
  let result = "";
  let offset = 0;
  for (const range of ranges) {
    result += text.slice(offset, range.start);
    offset = range.end;
  }
  return result + text.slice(offset);
}
