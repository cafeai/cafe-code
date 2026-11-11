/** Explicit composer syntax only. Escapes are retained on the wire so retries,
 * storage and a second admission cannot turn literal text into a new secret. */
export interface CafeSecretRange {
  readonly start: number;
  readonly end: number;
}
export interface CafeSecretSpan extends CafeSecretRange {
  readonly value: string;
}

const escapedAt = (text: string, position: number): boolean => {
  let count = 0;
  while (position > 0 && text[--position] === "\\") count++;
  return count % 2 === 1;
};

export function findCafeSecretRanges(text: string): readonly CafeSecretRange[] {
  const ranges: CafeSecretRange[] = [];
  for (let start = text.indexOf("[sec:"); start !== -1;) {
    if (escapedAt(text, start)) {
      start = text.indexOf("[sec:", start + 5);
      continue;
    }
    let end = start + 5;
    while (end < text.length && (text[end] !== "]" || escapedAt(text, end))) end++;
    ranges.push({ start, end: end < text.length ? end + 1 : text.length });
    start = text.indexOf("[sec:", end + 1);
  }
  return ranges;
}

export const containsCafeSecrets = (text: string): boolean => findCafeSecretRanges(text).length > 0;

export function parseCafeSecrets(text: string): {
  readonly text: string;
  readonly spans: readonly CafeSecretSpan[];
} {
  return {
    text,
    spans: findCafeSecretRanges(text)
      .filter((range) => text[range.end - 1] === "]" && !escapedAt(text, range.end - 1))
      .map((range) => ({
        ...range,
        value: text.slice(range.start + 5, range.end - 1).replace(/\\([\\\]])/g, "$1"),
      })),
  };
}

export const supportsCafeSecrets = (driver: string | undefined): boolean =>
  driver === "codex" || driver === "claudeAgent";

export const cafeSecretReference = (id: string): string => `[CAFE_SECRET_${id}]`;
export const CAFE_SECRET_REFERENCE_PATTERN = /\[CAFE_SECRET_([a-f0-9]{32})\]/g;
export const findCafeSecretReferenceRanges = (
  text: string,
): readonly (CafeSecretRange & { readonly id: string })[] =>
  [...text.matchAll(/\[CAFE_SECRET_([a-f0-9]{32})\]/g)]
    .filter((match) => !escapedAt(text, match.index))
    .map((match) => ({ start: match.index, end: match.index + match[0].length, id: match[1]! }));
export const hasCafeSecretReference = (text: string): boolean =>
  findCafeSecretReferenceRanges(text).length > 0;

/** Values are string data, never replacement templates or recursively expanded code. */
export function substituteCafeSecretReferences(
  text: string,
  values: ReadonlyMap<string, string>,
): string {
  return text.replace(
    /\[CAFE_SECRET_([^\]\r\n]*)\]/g,
    (match: string, id: string, offset: number) => {
      if (escapedAt(text, offset)) return match;
      const value = values.get(id);
      if (value === undefined)
        throw new Error("A Cafe Secret reference is unavailable in this chat.");
      return value;
    },
  );
}

export function redactCafeSecretText(
  text: string,
  values: Iterable<readonly [string, string]>,
): string {
  const entries = [...values].filter(([, value]) => value.length > 0);
  // Already-published references remain stable under nested wrappers and
  // output hooks, including when a short value occurs inside a reference ID.
  const references = [...text.matchAll(/\[CAFE_SECRET_[a-f0-9]{32}\]/g)];
  let result = "";
  const limit = 1_048_576;
  const omitted = "\n[Cafe Secrets output truncated]";
  const append = (part: string): boolean => {
    if (result.length + part.length <= limit) {
      result += part;
      return true;
    }
    result += part.slice(0, Math.max(0, limit - result.length)) + omitted;
    return false;
  };
  let offset = 0;
  while (offset < text.length) {
    let found: { index: number; id: string; value: string } | undefined;
    for (const [id, value] of entries) {
      let index = text.indexOf(value, offset);
      while (index >= 0) {
        const reference = references.find(
          (reference) =>
            index < reference.index! + reference[0].length &&
            index + value.length > reference.index!,
        );
        if (!reference) break;
        index = text.indexOf(value, reference.index! + reference[0].length);
      }
      if (
        index >= 0 &&
        (!found ||
          index < found.index ||
          (index === found.index && value.length > found.value.length))
      )
        found = { index, id, value };
    }
    if (!found) {
      append(text.slice(offset));
      return result;
    }
    if (!append(text.slice(offset, found.index)) || !append(cafeSecretReference(found.id)))
      return result;
    offset = found.index + found.value.length;
  }
  return result;
}

/** Retain enough lookahead that a value split across native output chunks is
 * never published partially. Each stream owns its own bounded pending tail. */
export function makeCafeSecretStreamRedactor(values: Iterable<readonly [string, string]>) {
  const entries = [...values]
    .filter(([, value]) => value.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  // A match can overlap the beginning of an already-published reference. The
  // extra token-length lookahead preserves that reserved token as one unit.
  const maximum = Math.max(1, ...entries.map(([, value]) => value.length)) + 46;
  let pending = "";
  let emitted = 0;
  let truncated = false;
  return (chunk: string, final = false): string => {
    if (truncated) return "";
    pending += chunk;
    const limit = final ? pending.length : Math.max(0, pending.length - maximum + 1);
    const references = [...pending.matchAll(/\[CAFE_SECRET_[a-f0-9]{32}\]/g)];
    const parts: string[] = [];
    let referenceIndex = 0;
    let cursor = 0;
    while (cursor < limit) {
      while (referenceIndex < references.length && references[referenceIndex]!.index! < cursor)
        referenceIndex++;
      const reference = references[referenceIndex];
      let part: string;
      if (reference?.index === cursor) {
        part = reference[0];
        cursor += part.length;
      } else {
        const match = entries.find(
          ([, value]) =>
            pending.startsWith(value, cursor) &&
            (!reference || cursor + value.length <= reference.index!),
        );
        if (match) {
          part = cafeSecretReference(match[0]);
          cursor += match[1].length;
        } else {
          const unit = pending.charCodeAt(cursor);
          const size = unit >= 0xd800 && unit <= 0xdbff && cursor + 1 < pending.length ? 2 : 1;
          part = pending.slice(cursor, cursor + size);
          cursor += size;
        }
      }
      if (emitted + part.length > 1_048_576) {
        const room = Math.max(0, 1_048_576 - emitted);
        const prefix = part.slice(0, room);
        parts.push(
          /[\ud800-\udbff]$/.test(prefix) ? prefix.slice(0, -1) : prefix,
          "\n[Cafe Secrets output truncated]",
        );
        truncated = true;
        pending = "";
        return parts.join("");
      }
      parts.push(part);
      emitted += part.length;
    }
    pending = pending.slice(cursor);
    return parts.join("");
  };
}
