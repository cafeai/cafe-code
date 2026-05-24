// @effect-diagnostics nodeBuiltinImport:off
import * as crypto from "node:crypto";

import {
  ProviderInstanceId,
  ProviderSupervisorId,
  ProviderSupervisorOwnerId,
  ProviderSupervisorSessionId,
  ThreadId,
  type ProviderSupervisorDiagnostics,
  type ProviderSupervisorOwnerKind,
  type ProviderSupervisorSession,
  type ProviderSupervisorStreamKind,
  type ProviderSupervisorTransferState,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ProviderSupervisorSessionRow {
  readonly sessionId: string;
  readonly supervisorId: string;
  readonly ownerId: string;
  readonly ownerKind: ProviderSupervisorOwnerKind;
  readonly threadId: string | null;
  readonly providerInstanceId: string | null;
  readonly providerKind: string | null;
  readonly providerPid: number | string | bigint | null;
  readonly commandDisplay: string | null;
  readonly cwd: string | null;
  readonly socketPath: string | null;
  readonly protocolVersion: number | string | bigint;
  readonly ioGeneration: number | string | bigint;
  readonly rawByteCursor: number | string | bigint;
  readonly parserCursor: number | string | bigint;
  readonly transferState: ProviderSupervisorTransferState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAttachedAt: string | null;
  readonly lastDetachedAt: string | null;
  readonly lastError: string | null;
}

export interface ProviderSupervisorOwnerProof {
  readonly sessionId: ProviderSupervisorSessionId;
  readonly ownerId: ProviderSupervisorOwnerId;
  readonly ioGeneration: number;
}

export interface ProviderSupervisorCreateInput {
  readonly sessionId?: ProviderSupervisorSessionId;
  readonly supervisorId: ProviderSupervisorId;
  readonly ownerId: ProviderSupervisorOwnerId;
  readonly ownerKind: ProviderSupervisorOwnerKind;
  readonly threadId?: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerKind?: string;
  readonly providerPid?: number;
  readonly commandDisplay?: string;
  readonly cwd?: string;
  readonly socketPath?: string;
  readonly protocolVersion?: number;
}

export interface ProviderSupervisorAdoptInput {
  readonly sessionId: ProviderSupervisorSessionId;
  readonly nextOwnerId: ProviderSupervisorOwnerId;
  readonly ownerKind: ProviderSupervisorOwnerKind;
  readonly detail?: unknown;
}

export interface ProviderSupervisorRegistryShape {
  readonly createSession: (
    input: ProviderSupervisorCreateInput,
  ) => Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError>;
  readonly getSession: (
    sessionId: ProviderSupervisorSessionId,
  ) => Effect.Effect<ProviderSupervisorSession | null>;
  readonly adoptSession: (
    input: ProviderSupervisorAdoptInput,
  ) => Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError>;
  readonly detachSession: (
    proof: ProviderSupervisorOwnerProof,
  ) => Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError>;
  readonly markTransferState: (
    proof: ProviderSupervisorOwnerProof,
    state: ProviderSupervisorTransferState,
    detail?: unknown,
  ) => Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError>;
  readonly recordIoEvent: (
    proof: ProviderSupervisorOwnerProof,
    input: {
      readonly streamKind: ProviderSupervisorStreamKind;
      readonly byteLength: number;
      readonly sha256?: string;
    },
  ) => Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError>;
  readonly advanceParserCursor: (
    proof: ProviderSupervisorOwnerProof,
    parserCursor: number,
  ) => Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError>;
  readonly snapshot: Effect.Effect<ProviderSupervisorDiagnostics>;
}

export class ProviderSupervisorSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSupervisorSessionNotFoundError>()(
  "ProviderSupervisorSessionNotFoundError",
  {
    sessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Provider supervisor session not found: ${this.sessionId}`;
  }
}

export class ProviderSupervisorOwnershipError extends Schema.TaggedErrorClass<ProviderSupervisorOwnershipError>()(
  "ProviderSupervisorOwnershipError",
  {
    sessionId: Schema.String,
    ownerId: Schema.String,
    ioGeneration: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Provider supervisor ownership rejected for ${this.sessionId}: ${this.detail}`;
  }
}

export class ProviderSupervisorInvalidCursorError extends Schema.TaggedErrorClass<ProviderSupervisorInvalidCursorError>()(
  "ProviderSupervisorInvalidCursorError",
  {
    sessionId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid provider supervisor cursor update for ${this.sessionId}: ${this.detail}`;
  }
}

export type ProviderSupervisorRegistryError =
  | ProviderSupervisorSessionNotFoundError
  | ProviderSupervisorOwnershipError
  | ProviderSupervisorInvalidCursorError
  | SqlError;

export class ProviderSupervisorRegistry extends Context.Service<
  ProviderSupervisorRegistry,
  ProviderSupervisorRegistryShape
>()("cafecode/providerSupervisor/ProviderSupervisorRegistry") {}

function normalizeSqlNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function makeSessionId(): ProviderSupervisorSessionId {
  return ProviderSupervisorSessionId.make(`pss_${crypto.randomUUID()}`);
}

const selectSessionColumns = `
  session_id AS "sessionId",
  supervisor_id AS "supervisorId",
  owner_id AS "ownerId",
  owner_kind AS "ownerKind",
  thread_id AS "threadId",
  provider_instance_id AS "providerInstanceId",
  provider_kind AS "providerKind",
  provider_pid AS "providerPid",
  command_display AS "commandDisplay",
  cwd,
  socket_path AS "socketPath",
  protocol_version AS "protocolVersion",
  io_generation AS "ioGeneration",
  raw_byte_cursor AS "rawByteCursor",
  parser_cursor AS "parserCursor",
  transfer_state AS "transferState",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  last_attached_at AS "lastAttachedAt",
  last_detached_at AS "lastDetachedAt",
  last_error AS "lastError"
`;

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeDetailJson(detail: unknown): string {
  return encodeUnknownJson(detail);
}

function rowToSession(row: ProviderSupervisorSessionRow): ProviderSupervisorSession {
  return {
    sessionId: ProviderSupervisorSessionId.make(row.sessionId),
    supervisorId: ProviderSupervisorId.make(row.supervisorId),
    ownerId: ProviderSupervisorOwnerId.make(row.ownerId),
    ownerKind: row.ownerKind,
    ...(row.threadId !== null ? { threadId: ThreadId.make(row.threadId) } : {}),
    ...(row.providerInstanceId !== null
      ? { providerInstanceId: ProviderInstanceId.make(row.providerInstanceId) }
      : {}),
    ...(row.providerKind !== null ? { providerKind: row.providerKind } : {}),
    ...(row.providerPid !== null ? { providerPid: normalizeSqlNumber(row.providerPid, 0) } : {}),
    ...(row.commandDisplay !== null ? { commandDisplay: row.commandDisplay } : {}),
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.socketPath !== null ? { socketPath: row.socketPath } : {}),
    protocolVersion: normalizeSqlNumber(row.protocolVersion, 1),
    ioGeneration: normalizeSqlNumber(row.ioGeneration, 1),
    rawByteCursor: normalizeSqlNumber(row.rawByteCursor, 0),
    parserCursor: normalizeSqlNumber(row.parserCursor, 0),
    transferState: row.transferState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastAttachedAt !== null ? { lastAttachedAt: row.lastAttachedAt } : {}),
    ...(row.lastDetachedAt !== null ? { lastDetachedAt: row.lastDetachedAt } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
  };
}

function rowToMaybeSession(
  row: ProviderSupervisorSessionRow | undefined,
): ProviderSupervisorSession | null {
  return row === undefined ? null : rowToSession(row);
}

function proofError(
  proof: ProviderSupervisorOwnerProof,
  detail: string,
): ProviderSupervisorOwnershipError {
  return new ProviderSupervisorOwnershipError({
    sessionId: proof.sessionId,
    ownerId: proof.ownerId,
    ioGeneration: proof.ioGeneration,
    detail,
  });
}

function requirePositiveInt(value: number, field: string, sessionId: ProviderSupervisorSessionId) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    return new ProviderSupervisorInvalidCursorError({
      sessionId,
      detail: `${field} must be a positive integer.`,
    });
  }
  return null;
}

export const makeProviderSupervisorRegistry: Effect.Effect<
  ProviderSupervisorRegistryShape,
  never,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readSession = (
    sessionId: ProviderSupervisorSessionId,
  ): Effect.Effect<ProviderSupervisorSession | null> =>
    Effect.gen(function* () {
      const rows = (yield* sql`
        SELECT ${sql.literal(selectSessionColumns)}
        FROM provider_supervisor_sessions
        WHERE session_id = ${sessionId}
        LIMIT 1
      `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
      return rowToMaybeSession(rows[0]);
    });

  const readRequiredSession = (
    sessionId: ProviderSupervisorSessionId,
  ): Effect.Effect<ProviderSupervisorSession, ProviderSupervisorSessionNotFoundError> =>
    readSession(sessionId).pipe(
      Effect.flatMap((session) =>
        session === null
          ? Effect.fail(new ProviderSupervisorSessionNotFoundError({ sessionId }))
          : Effect.succeed(session),
      ),
    );

  const requireProof = (
    proof: ProviderSupervisorOwnerProof,
  ): Effect.Effect<ProviderSupervisorSession, ProviderSupervisorRegistryError> =>
    readRequiredSession(proof.sessionId).pipe(
      Effect.flatMap((session) => {
        if (session.ownerId !== proof.ownerId) {
          return Effect.fail(
            proofError(
              proof,
              `owner mismatch: current owner is '${session.ownerId}', not '${proof.ownerId}'.`,
            ),
          );
        }
        if (session.ioGeneration !== proof.ioGeneration) {
          return Effect.fail(
            proofError(
              proof,
              `generation mismatch: current generation is ${session.ioGeneration}, not ${proof.ioGeneration}.`,
            ),
          );
        }
        return Effect.succeed(session);
      }),
    );

  const recordOwnershipEvent = (input: {
    readonly session: ProviderSupervisorSession;
    readonly eventType: "created" | "adopted" | "detached" | "transfer-state" | "cursor" | "error";
    readonly previousOwnerId?: ProviderSupervisorOwnerId;
    readonly detail?: unknown;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const emittedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO provider_supervisor_ownership_events (
          session_id,
          event_type,
          owner_id,
          previous_owner_id,
          io_generation,
          transfer_state,
          emitted_at,
          detail_json
        )
        VALUES (
          ${input.session.sessionId},
          ${input.eventType},
          ${input.session.ownerId},
          ${input.previousOwnerId ?? null},
          ${input.session.ioGeneration},
          ${input.session.transferState},
          ${emittedAt},
          ${input.detail === undefined ? null : encodeDetailJson(input.detail)}
        )
      `.pipe(Effect.orDie);
    });

  const createSession: ProviderSupervisorRegistryShape["createSession"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const sessionId = input.sessionId ?? makeSessionId();
        const rows = (yield* sql`
          INSERT INTO provider_supervisor_sessions (
            session_id,
            supervisor_id,
            owner_id,
            owner_kind,
            thread_id,
            provider_instance_id,
            provider_kind,
            provider_pid,
            command_display,
            cwd,
            socket_path,
            protocol_version,
            io_generation,
            raw_byte_cursor,
            parser_cursor,
            transfer_state,
            created_at,
            updated_at,
            last_attached_at
          )
          VALUES (
            ${sessionId},
            ${input.supervisorId},
            ${input.ownerId},
            ${input.ownerKind},
            ${input.threadId ?? null},
            ${input.providerInstanceId ?? null},
            ${input.providerKind ?? null},
            ${input.providerPid ?? null},
            ${input.commandDisplay ?? null},
            ${input.cwd ?? null},
            ${input.socketPath ?? null},
            ${input.protocolVersion ?? 1},
            1,
            0,
            0,
            'running',
            ${now},
            ${now},
            ${now}
          )
          RETURNING ${sql.literal(selectSessionColumns)}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.die(new Error("provider supervisor insert did not return a row"));
        }
        const session = rowToSession(row);
        yield* recordOwnershipEvent({
          session,
          eventType: "created",
          detail: { ownerKind: input.ownerKind },
        });
        return session;
      }),
    );

  const adoptSession: ProviderSupervisorRegistryShape["adoptSession"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* readRequiredSession(input.sessionId);
        const now = DateTime.formatIso(yield* DateTime.now);
        const nextGeneration = previous.ioGeneration + 1;
        const rows = (yield* sql`
          UPDATE provider_supervisor_sessions
          SET
            owner_id = ${input.nextOwnerId},
            owner_kind = ${input.ownerKind},
            io_generation = ${nextGeneration},
            transfer_state = 'running',
            updated_at = ${now},
            last_attached_at = ${now},
            last_error = NULL
          WHERE session_id = ${input.sessionId}
          RETURNING ${sql.literal(selectSessionColumns)}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
        const row = rows[0];
        if (row === undefined) {
          return yield* new ProviderSupervisorSessionNotFoundError({ sessionId: input.sessionId });
        }
        const session = rowToSession(row);
        yield* recordOwnershipEvent({
          session,
          eventType: "adopted",
          previousOwnerId: previous.ownerId,
          detail: input.detail,
        });
        return session;
      }),
    );

  const detachSession: ProviderSupervisorRegistryShape["detachSession"] = (proof) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* requireProof(proof);
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = (yield* sql`
          UPDATE provider_supervisor_sessions
          SET
            transfer_state = 'detached',
            updated_at = ${now},
            last_detached_at = ${now}
          WHERE session_id = ${proof.sessionId}
          RETURNING ${sql.literal(selectSessionColumns)}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
        const session = rowToSession(rows[0]!);
        yield* recordOwnershipEvent({ session, eventType: "detached" });
        return session;
      }),
    );

  const markTransferState: ProviderSupervisorRegistryShape["markTransferState"] = (
    proof,
    state,
    detail,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* requireProof(proof);
        const now = DateTime.formatIso(yield* DateTime.now);
        const lastError =
          state === "error" && detail !== undefined
            ? typeof detail === "string"
              ? detail
              : encodeDetailJson(detail)
            : null;
        const rows = (yield* sql`
          UPDATE provider_supervisor_sessions
          SET
            transfer_state = ${state},
            updated_at = ${now},
            last_error = ${lastError}
          WHERE session_id = ${proof.sessionId}
          RETURNING ${sql.literal(selectSessionColumns)}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
        const session = rowToSession(rows[0]!);
        yield* recordOwnershipEvent({
          session,
          eventType: state === "error" ? "error" : "transfer-state",
          detail,
        });
        return session;
      }),
    );

  const recordIoEvent: ProviderSupervisorRegistryShape["recordIoEvent"] = (proof, input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const cursorError = requirePositiveInt(input.byteLength, "byteLength", proof.sessionId);
        if (cursorError !== null) {
          return yield* cursorError;
        }
        const current = yield* requireProof(proof);
        const now = DateTime.formatIso(yield* DateTime.now);
        const nextRawByteCursor = current.rawByteCursor + input.byteLength;
        yield* sql`
          INSERT INTO provider_supervisor_io_events (
            session_id,
            stream_kind,
            byte_offset,
            byte_length,
            emitted_at,
            sha256
          )
          VALUES (
            ${proof.sessionId},
            ${input.streamKind},
            ${current.rawByteCursor},
            ${input.byteLength},
            ${now},
            ${input.sha256 ?? null}
          )
        `.pipe(Effect.orDie);
        const rows = (yield* sql`
          UPDATE provider_supervisor_sessions
          SET
            raw_byte_cursor = ${nextRawByteCursor},
            updated_at = ${now}
          WHERE session_id = ${proof.sessionId}
          RETURNING ${sql.literal(selectSessionColumns)}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
        const session = rowToSession(rows[0]!);
        yield* recordOwnershipEvent({
          session,
          eventType: "cursor",
          detail: {
            streamKind: input.streamKind,
            byteLength: input.byteLength,
            rawByteCursor: nextRawByteCursor,
          },
        });
        return session;
      }),
    );

  const advanceParserCursor: ProviderSupervisorRegistryShape["advanceParserCursor"] = (
    proof,
    parserCursor,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (!Number.isFinite(parserCursor) || !Number.isInteger(parserCursor) || parserCursor < 0) {
          return yield* new ProviderSupervisorInvalidCursorError({
            sessionId: proof.sessionId,
            detail: "parserCursor must be a non-negative integer.",
          });
        }
        const current = yield* requireProof(proof);
        const nextParserCursor = Math.max(current.parserCursor, parserCursor);
        if (nextParserCursor === current.parserCursor) {
          return current;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = (yield* sql`
          UPDATE provider_supervisor_sessions
          SET
            parser_cursor = ${nextParserCursor},
            updated_at = ${now}
          WHERE session_id = ${proof.sessionId}
          RETURNING ${sql.literal(selectSessionColumns)}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
        const session = rowToSession(rows[0]!);
        yield* recordOwnershipEvent({
          session,
          eventType: "cursor",
          detail: { parserCursor: nextParserCursor },
        });
        return session;
      }),
    );

  const snapshot: Effect.Effect<ProviderSupervisorDiagnostics> = Effect.gen(function* () {
    const rows = (yield* sql`
      SELECT ${sql.literal(selectSessionColumns)}
      FROM provider_supervisor_sessions
      ORDER BY updated_at DESC, session_id ASC
    `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderSupervisorSessionRow>;
    const sessions = rows.map(rowToSession);
    return {
      sessionCount: sessions.length,
      runningSessionCount: sessions.filter((session) => session.transferState === "running").length,
      transferringSessionCount: sessions.filter(
        (session) =>
          session.transferState === "preparing-transfer" ||
          session.transferState === "transferring",
      ).length,
      detachedSessionCount: sessions.filter((session) => session.transferState === "detached")
        .length,
      stoppedSessionCount: sessions.filter((session) => session.transferState === "stopped").length,
      errorSessionCount: sessions.filter((session) => session.transferState === "error").length,
      maxRawByteCursor: sessions.reduce((max, session) => Math.max(max, session.rawByteCursor), 0),
      maxParserCursor: sessions.reduce((max, session) => Math.max(max, session.parserCursor), 0),
      sessions,
    };
  });

  return {
    createSession,
    getSession: readSession,
    adoptSession,
    detachSession,
    markTransferState,
    recordIoEvent,
    advanceParserCursor,
    snapshot,
  };
});

export const ProviderSupervisorRegistryLive = Layer.effect(
  ProviderSupervisorRegistry,
  makeProviderSupervisorRegistry,
);
