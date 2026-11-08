// Native digest/encoding boundary for inert, query-bound read cursors only.
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { McpToolError } from "./results.ts";

export const pageInput = {
  query: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Case-insensitive title/name substring; all matching candidates retain exact IDs."),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional(),
};
export const pageOutput = {
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  totalMatches: z.number().int().nonnegative(),
};
const parseJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const cursorSchema = z
  .object({ v: z.literal(1), scope: z.string(), after: z.string().max(4096) })
  .strict();
export function matchesQuery(
  query: string | undefined,
  ...values: (string | undefined)[]
): boolean {
  return (
    query === undefined ||
    values.some((value) =>
      value?.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US")),
    )
  );
}

/** Stable immutable-ID keysets avoid offset shifts as titles/status change.
 * These are live reads, not snapshot claims or authority to mutate a target. */
export function paginate<T>(
  values: readonly T[],
  input: { limit: number; cursor?: string },
  scope: unknown,
  key: (value: T) => string,
) {
  const scopeHash = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  let after: string | undefined;
  if (input.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
      const parsed = cursorSchema.parse(
        parseJson(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (parsed.scope !== scopeHash) throw new Error();
      after = parsed.after;
    } catch {
      throw new McpToolError(
        "invalid_request",
        "This cursor is invalid or belongs to a different query.",
        "Repeat the original discovery read without a cursor.",
      );
    }
  }
  const ordered = values.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const remaining = after === undefined ? ordered : ordered.filter((value) => key(value) > after!);
  const items = remaining.slice(0, input.limit);
  const hasMore = remaining.length > items.length;
  const last = items.at(-1);
  return {
    items,
    totalMatches: values.length,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ v: 1, scope: scopeHash, after: key(last) })).toString(
            "base64url",
          )
        : null,
  };
}
