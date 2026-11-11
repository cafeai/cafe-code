// Native hashing boundary: inputs are hashed in memory and never stored/logged.
import { createHash } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { z } from "zod";
import { McpToolError } from "./results.ts";

export const MAX_MCP_OPERATIONS = 10_000;
export const requestIdSchema = z
  .string()
  .uuid()
  .describe(
    "Generate a UUID before the action and retain it for get_operation. Reusing it never executes another action in this bearer session.",
  );
export const operationStateSchema = z.enum([
  "unconfirmed",
  "recorded",
  "scheduled",
  "completed",
  "failed",
]);
export type OperationState = z.infer<typeof operationStateSchema>;
export const operationReferenceSchema = z.object({
  requestId: requestIdSchema,
  scope: z.literal("bearer-session"),
  scopeId: z.string(),
  state: operationStateSchema,
  expiresAt: z.string(),
  lookupTool: z.literal("get_operation"),
});
export interface McpOperationOwner {
  readonly sessionId: string;
  readonly expiresAt: string;
}
export interface McpOperation {
  readonly requestId: string;
  readonly tool: string;
  readonly state: OperationState;
  readonly inputHash: string;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}
export interface McpOperationsShape {
  readonly reserve: (
    owner: McpOperationOwner,
    requestId: string,
    tool: string,
    inputHash: string,
  ) => Effect.Effect<{ readonly fresh: boolean; readonly operation: McpOperation }, McpToolError>;
  readonly get: (
    owner: McpOperationOwner,
    requestId: string,
  ) => Effect.Effect<McpOperation | null, McpToolError>;
  readonly settle: (
    owner: McpOperationOwner,
    requestId: string,
    state: OperationState,
    result?: Record<string, unknown>,
  ) => Effect.Effect<void, McpToolError>;
}
export class McpOperations extends Context.Service<McpOperations, McpOperationsShape>()(
  "cafecode/mcp/McpOperations",
) {}

export function operationScopeId(owner: McpOperationOwner): string {
  return createHash("sha256").update("cafe-mcp-owner-v1\0").update(owner.sessionId).digest("hex");
}

/** Object key order is not intent. Arrays (including option lists) retain their
 * order; tool and exact target are part of the digest. Never expose this hash. */
export function operationInputHash(owner: McpOperationOwner, tool: string, input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, canonical(value)]),
      );
    return value;
  };
  return createHash("sha256")
    .update("cafe-mcp-input-v1\0")
    .update(operationScopeId(owner))
    .update("\0")
    .update(tool)
    .update("\0")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}

/** Tools whose created target ID is derived from the reservation. */
export const PLANNED_TARGET_TOOLS = {
  create_thread: "threadId",
  create_thread_group: "groupId",
} as const;

/**
 * Deterministic target ID for a reserved create request: the same bearer
 * scope, requestId and tool always name the same thread/group. A receipt can
 * therefore point at the exact target to confirm a positive recorded result,
 * and an engine-level duplicate is refused by ID. This is a reconciliation
 * aid only: a lookup that finds the target absent at one moment does not prove
 * that the originally admitted, possibly delayed action cannot still create
 * it, and grants no authority to replay or issue a replacement request.
 */
export function plannedTargetId(
  owner: McpOperationOwner,
  requestId: string,
  tool: keyof typeof PLANNED_TARGET_TOOLS,
): string {
  const hex = createHash("sha256")
    .update("cafe-mcp-planned-target-v1\0")
    .update(operationScopeId(owner))
    .update("\0")
    .update(tool)
    .update("\0")
    .update(requestId)
    .digest("hex");
  // UUID-shaped (version 8, RFC 9562 custom) for readability; not a secret.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic command ID so engine receipts also dedupe a re-dispatch. */
export function plannedCommandId(owner: McpOperationOwner, requestId: string, tool: string) {
  return `mcp:${createHash("sha256")
    .update("cafe-mcp-command-v1\0")
    .update(operationScopeId(owner))
    .update("\0")
    .update(tool)
    .update("\0")
    .update(requestId)
    .digest("hex")
    .slice(0, 48)}`;
}

export function operationReference(
  owner: McpOperationOwner,
  requestId: string,
  state: OperationState,
) {
  return {
    requestId,
    scope: "bearer-session" as const,
    scopeId: operationScopeId(owner),
    state,
    expiresAt: owner.expiresAt,
    lookupTool: "get_operation" as const,
  };
}

const rowSchema = Schema.Struct({
  requestId: Schema.String,
  tool: Schema.String,
  state: Schema.Literals(["unconfirmed", "recorded", "scheduled", "completed", "failed"]),
  inputHash: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(rowSchema));
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

export const makeMcpOperations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (owner: McpOperationOwner, requestId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql`
      SELECT request_id AS "requestId", tool, state, input_hash AS "inputHash",
        result_json AS "resultJson", created_at AS "createdAt", updated_at AS "updatedAt", expires_at AS "expiresAt"
      FROM mcp_operations WHERE owner_hash = ${operationScopeId(owner)} AND request_id = ${requestId}
    `.pipe(Effect.flatMap(decodeRows));
      const row = rows[0];
      if (!row) return null;
      const { resultJson, ...rest } = row;
      const result = resultJson === null ? null : decodeJson(resultJson);
      if (result !== null && (typeof result !== "object" || Array.isArray(result)))
        return yield* Effect.fail(
          new McpToolError("unavailable", "The operation receipt is unavailable."),
        );
      return { ...rest, result: result as Record<string, unknown> | null } satisfies McpOperation;
    });
  const safe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof McpToolError
          ? error
          : new McpToolError(
              "unavailable",
              "Operation tracking is unavailable.",
              "Read the current state; do not repeat an uncertain action.",
            ),
      ),
    );
  const get: McpOperationsShape["get"] = (owner, requestId) => safe(read(owner, requestId));
  const reserve: McpOperationsShape["reserve"] = (owner, requestId, tool, inputHash) =>
    safe(
      sql.withTransaction(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          if (!Number.isFinite(Date.parse(owner.expiresAt)) || owner.expiresAt <= now)
            return yield* Effect.fail(
              new McpToolError(
                "unavailable",
                "A fresh expiring bearer session is required to track actions.",
              ),
            );
          // A retired credential cannot read or reserve again. Expiry deletion never
          // permits reuse within an authenticated owner's still-valid namespace.
          yield* sql`DELETE FROM mcp_operations WHERE expires_at <= ${now}`;
          const existing = yield* read(owner, requestId);
          if (existing) {
            if (existing.tool !== tool || existing.inputHash !== inputHash)
              return yield* Effect.fail(
                new McpToolError(
                  "conflict",
                  "This requestId already belongs to a different action.",
                  "Inspect get_operation; use a new requestId only for a separately intended action.",
                ),
              );
            return { fresh: false, operation: existing };
          }
          const counts = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM mcp_operations`;
          if ((counts[0]?.count ?? MAX_MCP_OPERATIONS) >= MAX_MCP_OPERATIONS)
            return yield* Effect.fail(
              new McpToolError(
                "capacity",
                "Operation receipt capacity is full; no action was started.",
              ),
            );
          yield* sql`INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state, result_json, created_at, updated_at, expires_at) VALUES (${operationScopeId(owner)}, ${requestId}, ${tool}, ${inputHash}, 'unconfirmed', NULL, ${now}, ${now}, ${owner.expiresAt})`;
          return {
            fresh: true,
            operation: {
              requestId,
              tool,
              inputHash,
              state: "unconfirmed" as const,
              result: null,
              createdAt: now,
              updatedAt: now,
              expiresAt: owner.expiresAt,
            },
          };
        }),
      ),
    );
  const settle: McpOperationsShape["settle"] = (owner, requestId, state, result) =>
    safe(
      Effect.gen(function* () {
        const json = result === undefined ? null : encodeJson(result);
        if (json !== null && Buffer.byteLength(json, "utf8") > 65_536)
          return yield* Effect.fail(
            new McpToolError("capacity", "The operation receipt exceeds its size limit."),
          );
        const now = DateTime.formatIso(yield* DateTime.now);
        // A fast background restart may finish before its caller stores the
        // scheduled receipt. Preserve that newer terminal stage, retaining data.
        yield* sql`UPDATE mcp_operations SET
      state = CASE WHEN state IN ('completed', 'failed') THEN state ELSE ${state} END,
      result_json = CASE
        WHEN ${json} IS NULL THEN result_json
        WHEN result_json IS NULL THEN ${json}
        WHEN state IN ('completed', 'failed') THEN json_patch(${json}, result_json)
        ELSE json_patch(result_json, ${json}) END,
      updated_at = ${now}
      WHERE owner_hash = ${operationScopeId(owner)} AND request_id = ${requestId}`;
      }),
    );
  return { get, reserve, settle } satisfies McpOperationsShape;
});
export const McpOperationsLive = Layer.effect(McpOperations, makeMcpOperations);
