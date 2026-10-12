/** Keep the published schema legible to tool clients that interpret allOf as
 * a type intersection. Effect emits separate bound-only branches; fold only
 * compatible assertions, retaining arbitrary intersections and definitions. */
export function normalizeNativeComputerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNativeComputerSchema);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeNativeComputerSchema(child)]),
  );
  if (!Array.isArray(result.allOf)) return result;
  const remaining: unknown[] = [];
  const lower = new Set(["minimum", "minLength", "minItems"]);
  const upper = new Set(["maximum", "maxLength", "maxItems"]);
  for (const branch of result.allOf) {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
      remaining.push(branch);
      continue;
    }
    const entries = Object.entries(branch);
    if (
      !entries.every(
        ([key, bound]) =>
          (lower.has(key) || upper.has(key)) &&
          typeof bound === "number" &&
          (result[key] === undefined || typeof result[key] === "number"),
      )
    ) {
      remaining.push(branch);
      continue;
    }
    for (const [key, bound] of entries) {
      const prior = result[key];
      result[key] =
        typeof prior === "number"
          ? lower.has(key)
            ? Math.max(prior, Number(bound))
            : Math.min(prior, Number(bound))
          : bound;
    }
  }
  if (remaining.length) result.allOf = remaining;
  else delete result.allOf;
  return result;
}
