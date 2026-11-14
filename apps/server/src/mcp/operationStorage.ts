/**
 * Frozen version-1 MCP receipt storage policy. Migration 109 imports this
 * module: changing an already-applied charge formula would make its generated
 * column, trigger accounting and current admission disagree. Introduce a new
 * versioned migration/policy for any future change instead.
 *
 * This bounds logical retained receipt storage, not native SQLite page, index,
 * WAL or free-list bytes. A positive metadata floor bounds the number of small
 * retained deduplication claims without discarding any live request identity.
 */
export const MCP_OPERATION_STORAGE_POLICY_VERSION = 1;
export const MCP_OPERATION_STORAGE_BUDGET_BYTES = 665_600_000;
export const MCP_OPERATION_RESULT_MAX_BYTES = 65_536;
export const MCP_OPERATION_METADATA_MIN_BYTES = 1_024;
export const MCP_OPERATION_METADATA_OVERHEAD_BYTES = 512;

export interface McpOperationStorageMetadata {
  readonly ownerHash: string;
  readonly requestId: string;
  readonly tool: string;
  readonly inputHash: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** All eight retained metadata values participate, including legacy timestamps
 * and multibyte strings. Do not substitute JavaScript character counts or a
 * fixed floor for their actual UTF-8 storage. Inputs are public receipt
 * metadata, never the original tool arguments, messages or credentials. */
export function operationStorageMetadataBytes(metadata: McpOperationStorageMetadata): number {
  return Math.max(
    MCP_OPERATION_METADATA_MIN_BYTES,
    MCP_OPERATION_METADATA_OVERHEAD_BYTES +
      Buffer.byteLength(metadata.ownerHash, "utf8") +
      Buffer.byteLength(metadata.requestId, "utf8") +
      Buffer.byteLength(metadata.tool, "utf8") +
      Buffer.byteLength(metadata.inputHash, "utf8") +
      Buffer.byteLength(metadata.state, "utf8") +
      Buffer.byteLength(metadata.createdAt, "utf8") +
      Buffer.byteLength(metadata.updatedAt, "utf8") +
      Buffer.byteLength(metadata.expiresAt, "utf8"),
  );
}

/** New reservations and scheduled work retain room for the largest permitted
 * result. Releasing unused reservation never withdraws the consumed request ID.
 * SQLite independently computes/enforces the final row's charge on every write.
 */
export function operationStorageReservationBytes(metadata: McpOperationStorageMetadata): number {
  return operationStorageMetadataBytes(metadata) + MCP_OPERATION_RESULT_MAX_BYTES;
}

/** Fixed SQL only: no caller-provided identifiers or values are interpolated.
 * Keep the complete formula frozen with migration 109. SQLite BLOB lengths
 * count the actual UTF-8 representation, including supplementary characters.
 */
export const MCP_OPERATION_STORAGE_BYTES_SQL = `
  max(1024, 512
    + length(CAST(owner_hash AS BLOB))
    + length(CAST(request_id AS BLOB))
    + length(CAST(tool AS BLOB))
    + length(CAST(input_hash AS BLOB))
    + length(CAST(state AS BLOB))
    + length(CAST(created_at AS BLOB))
    + length(CAST(updated_at AS BLOB))
    + length(CAST(expires_at AS BLOB)))
  + CASE WHEN state IN ('unconfirmed', 'scheduled') THEN 65536
      ELSE coalesce(length(CAST(result_json AS BLOB)), 0) END
`;
