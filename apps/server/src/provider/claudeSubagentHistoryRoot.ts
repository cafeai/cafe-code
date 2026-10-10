/**
 * Read only Claude's native conversation identity, not its mutable resume
 * checkpoints. Child transcript ownership survives turn-count/checkpoint
 * changes, but it must never borrow a different native root or turn an
 * incomplete legacy cursor into authority.
 */
export function normalizeClaudeSubagentHistoryRoot(
  value: unknown,
): { readonly resume: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    // These cursors cross JSON/schema boundaries. Refuse custom prototypes and
    // inherited/accessor identity fields rather than evaluating provider-owned
    // code or letting a prototype supply missing ownership evidence.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const readField = (key: "resume" | "sessionId") => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined)
        return "value" in descriptor ? { present: true, value: descriptor.value } : undefined;
      if (prototype !== null && Object.getOwnPropertyDescriptor(prototype, key) !== undefined)
        return undefined;
      return { present: false, value: undefined };
    };
    const resume = readField("resume");
    if (resume === undefined) return undefined;
    // Preserve the SDK adapter's resume-string precedence. A malformed string
    // cannot fall through to a valid alias naming another native conversation.
    const candidate =
      typeof resume.value === "string" ? resume.value : readField("sessionId")?.value;
    if (
      typeof candidate !== "string" ||
      candidate.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    )
      return undefined;
    // Reconstruct one inert fixed-key object. Do not stringify/spread the
    // original cursor: unrelated maps, toJSON hooks and getters are irrelevant
    // to this identity and must not execute merely to compare history roots.
    return { resume: candidate };
  } catch {
    return undefined;
  }
}
