/**
 * SQL helpers for thread organization metadata (migration 108).
 *
 * `projection_thread_metadata` is a sidecar keyed by thread; a missing row is
 * a historical thread (top level, unrecorded origin). Writes patch individual
 * columns so one event never clears another event's field. These records are
 * organisation and recorded facts only — never authority.
 */
import {
  OrchestrationThreadGroup,
  type OrchestrationThreadGroupSummary,
  ThreadGroupProvenance,
  ThreadProvenance,
  type CommandId,
  type ThreadGroupId,
  type ThreadId,
  type ThreadOrigin,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ThreadOrganizationRecord {
  readonly groupId: ThreadGroupId | null;
  readonly origin: ThreadOrigin | null;
  readonly description: string | null;
  readonly provenance: typeof ThreadProvenance.Type | null;
  readonly deletionId: CommandId | null;
  readonly archiveCascadeId: CommandId | null;
}

interface MetadataRow {
  readonly threadId: string;
  readonly groupId: string | null;
  readonly originClassification: string | null;
  readonly originSource: string | null;
  readonly originUpdatedAt: string | null;
  readonly description: string | null;
  readonly provenanceJson: string | null;
  readonly deletionId: string | null;
  readonly archiveCascadeId: string | null;
}

interface GroupRow {
  readonly groupId: string;
  readonly ownerThreadId: string;
  readonly title: string;
  readonly description: string | null;
  readonly provenanceJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deletionId: string | null;
}

const decodeProvenance = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadProvenance));
const decodeGroup = Schema.decodeUnknownOption(OrchestrationThreadGroup);
const decodeGroupProvenance = Schema.decodeUnknownOption(
  Schema.fromJsonString(ThreadGroupProvenance),
);

/** Malformed stored values degrade to "unrecorded", never to a guessed value. */
function toRecord(row: MetadataRow): ThreadOrganizationRecord {
  const classification = row.originClassification;
  const source = row.originSource;
  const origin: ThreadOrigin | null =
    (classification === "human" || classification === "agent" || classification === "unknown") &&
    (source === "recorded" || source === "user") &&
    row.originUpdatedAt !== null
      ? { classification, source, updatedAt: row.originUpdatedAt }
      : null;
  const provenance =
    row.provenanceJson === null ? null : Option.getOrNull(decodeProvenance(row.provenanceJson));
  return {
    groupId: row.groupId as ThreadGroupId | null,
    origin,
    description: row.description,
    provenance,
    deletionId: row.deletionId as CommandId | null,
    archiveCascadeId: row.archiveCascadeId as CommandId | null,
  };
}

function toGroup(row: GroupRow): OrchestrationThreadGroup | null {
  const provenance = decodeGroupProvenance(row.provenanceJson);
  if (Option.isNone(provenance)) return null;
  const decoded = decodeGroup({
    id: row.groupId,
    ownerThreadId: row.ownerThreadId,
    title: row.title,
    description: row.description,
    provenance: provenance.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    deletionId: row.deletionId,
  });
  return Option.getOrNull(decoded);
}

const metadataColumns = `
  thread_id AS "threadId",
  group_id AS "groupId",
  origin_classification AS "originClassification",
  origin_source AS "originSource",
  origin_updated_at AS "originUpdatedAt",
  description,
  provenance_json AS "provenanceJson",
  deletion_id AS "deletionId",
  archive_cascade_id AS "archiveCascadeId"
`;

const groupColumns = `
  group_id AS "groupId",
  owner_thread_id AS "ownerThreadId",
  title,
  description,
  provenance_json AS "provenanceJson",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt",
  deletion_id AS "deletionId"
`;

/** Read metadata for one thread, or every thread when `threadId` is null. */
export const readThreadOrganization = (sql: SqlClient.SqlClient, threadId: ThreadId | null) =>
  (threadId === null
    ? sql.unsafe<MetadataRow>(`SELECT ${metadataColumns} FROM projection_thread_metadata`)
    : sql.unsafe<MetadataRow>(
        `SELECT ${metadataColumns} FROM projection_thread_metadata WHERE thread_id = ?`,
        [threadId],
      )
  ).pipe(
    Effect.map((rows) => {
      const result = new Map<string, ThreadOrganizationRecord>();
      for (const row of rows) result.set(row.threadId, toRecord(row));
      return result;
    }),
  );

/** All retained group records (live and soft-deleted) for the engine read model. */
export const readAllThreadGroups = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe<GroupRow>(
      `SELECT ${groupColumns} FROM projection_thread_groups ORDER BY created_at ASC, group_id ASC`,
    )
    .pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const group = toGroup(row);
          return group ? [group] : [];
        }),
      ),
    );

/** Live group summaries per owner, for one owner or every owner. */
export const readLiveGroupSummaries = (sql: SqlClient.SqlClient, ownerThreadId: ThreadId | null) =>
  (ownerThreadId === null
    ? sql.unsafe<GroupRow>(
        `SELECT ${groupColumns} FROM projection_thread_groups WHERE deleted_at IS NULL
         ORDER BY created_at ASC, group_id ASC`,
      )
    : sql.unsafe<GroupRow>(
        `SELECT ${groupColumns} FROM projection_thread_groups
         WHERE owner_thread_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC, group_id ASC`,
        [ownerThreadId],
      )
  ).pipe(
    Effect.map((rows) => {
      const result = new Map<string, OrchestrationThreadGroupSummary[]>();
      for (const row of rows) {
        const group = toGroup(row);
        if (!group) continue;
        const list = result.get(group.ownerThreadId) ?? [];
        list.push({ id: group.id, title: group.title, createdAt: group.createdAt });
        result.set(group.ownerThreadId, list);
      }
      return result;
    }),
  );

export const readThreadGroupById = (sql: SqlClient.SqlClient, groupId: ThreadGroupId) =>
  sql
    .unsafe<GroupRow>(`SELECT ${groupColumns} FROM projection_thread_groups WHERE group_id = ?`, [
      groupId,
    ])
    .pipe(Effect.map((rows) => (rows[0] ? toGroup(rows[0]) : null)));

type MetadataPatch = {
  readonly groupId?: ThreadGroupId | null;
  readonly origin?: ThreadOrigin | null;
  readonly description?: string | null;
  readonly provenance?: typeof ThreadProvenance.Type | null;
  readonly deletionId?: CommandId | null;
  readonly archiveCascadeId?: CommandId | null;
};

/**
 * Patch only the supplied columns, creating the row on first write. Legacy
 * threads gain a row lazily (e.g. a cascade tag) without inventing origin.
 */
export const patchThreadMetadata = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  patch: MetadataPatch,
  updatedAt: string,
) => {
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  const set = (column: string, value: string | null) => {
    assignments.push(column);
    values.push(value);
  };
  if (patch.groupId !== undefined) set("group_id", patch.groupId);
  if (patch.origin !== undefined) {
    set("origin_classification", patch.origin?.classification ?? null);
    set("origin_source", patch.origin?.source ?? null);
    set("origin_updated_at", patch.origin?.updatedAt ?? null);
  }
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.provenance !== undefined)
    set("provenance_json", patch.provenance === null ? null : JSON.stringify(patch.provenance));
  if (patch.deletionId !== undefined) set("deletion_id", patch.deletionId);
  if (patch.archiveCascadeId !== undefined) set("archive_cascade_id", patch.archiveCascadeId);
  if (assignments.length === 0) return Effect.void;
  const columns = ["thread_id", ...assignments, "updated_at"];
  const placeholders = columns.map(() => "?").join(", ");
  const updates = [...assignments, "updated_at"].map((column) => `${column} = excluded.${column}`);
  return sql
    .unsafe(
      `INSERT INTO projection_thread_metadata (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(thread_id) DO UPDATE SET ${updates.join(", ")}`,
      [threadId, ...values, updatedAt],
    )
    .pipe(Effect.asVoid);
};

/** Patch existing rows only; a missing row already means the default value. */
export const clearThreadMetadataColumn = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  column: "deletion_id" | "archive_cascade_id",
  updatedAt: string,
) =>
  sql
    .unsafe(
      `UPDATE projection_thread_metadata SET ${column} = NULL, updated_at = ?
       WHERE thread_id = ? AND ${column} IS NOT NULL`,
      [updatedAt, threadId],
    )
    .pipe(Effect.asVoid);

export const insertThreadGroup = (sql: SqlClient.SqlClient, group: OrchestrationThreadGroup) =>
  sql
    .unsafe(
      `INSERT INTO projection_thread_groups (
         group_id, owner_thread_id, title, description, provenance_json,
         created_at, updated_at, deleted_at, deletion_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO NOTHING`,
      [
        group.id,
        group.ownerThreadId,
        group.title,
        group.description,
        JSON.stringify(group.provenance),
        group.createdAt,
        group.updatedAt,
        group.deletedAt,
        group.deletionId,
      ],
    )
    .pipe(Effect.asVoid);

export const updateThreadGroup = (
  sql: SqlClient.SqlClient,
  groupId: ThreadGroupId,
  patch: {
    readonly title?: string;
    readonly description?: string | null;
    readonly deletedAt?: string | null;
    readonly deletionId?: CommandId | null;
  },
  updatedAt: string,
) => {
  const assignments: string[] = [];
  const values: Array<string | null> = [];
  const set = (column: string, value: string | null) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.deletedAt !== undefined) set("deleted_at", patch.deletedAt);
  if (patch.deletionId !== undefined) set("deletion_id", patch.deletionId);
  assignments.push("updated_at = ?");
  values.push(updatedAt);
  return sql
    .unsafe(`UPDATE projection_thread_groups SET ${assignments.join(", ")} WHERE group_id = ?`, [
      ...values,
      groupId,
    ])
    .pipe(Effect.asVoid);
};

/**
 * Hard-delete support: remove groups owned by the purged thread and return
 * their surviving (recycle-bin or live) members to top level, so they cannot
 * be orphaned beneath a group that no longer exists.
 */
export const purgeOwnedThreadGroups = (sql: SqlClient.SqlClient, ownerThreadId: ThreadId) =>
  Effect.gen(function* () {
    yield* sql.unsafe(
      `UPDATE projection_thread_metadata SET group_id = NULL
       WHERE group_id IN (SELECT group_id FROM projection_thread_groups WHERE owner_thread_id = ?)`,
      [ownerThreadId],
    );
    yield* sql.unsafe(`DELETE FROM projection_thread_groups WHERE owner_thread_id = ?`, [
      ownerThreadId,
    ]);
    yield* sql.unsafe(`DELETE FROM projection_thread_metadata WHERE thread_id = ?`, [
      ownerThreadId,
    ]);
  });
