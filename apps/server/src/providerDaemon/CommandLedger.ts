import {
  ProviderDaemonRpcEnvelope,
  ProviderDaemonRpcRequest,
  type ProviderDaemonCommandDiagnostic,
  type ProviderDaemonRpcEnvelope as ProviderDaemonRpcEnvelopeValue,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeProviderDaemonRpcEnvelopeJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonRpcEnvelope),
);
const decodeProviderDaemonRpcEnvelopeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRpcEnvelope),
);
const decodeProviderDaemonRpcRequestJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRpcRequest),
);
const encodeProviderDaemonRpcRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonRpcRequest),
);

const MUTATING_METHODS = new Set<ProviderDaemonRpcRequest["method"]>([
  "startSession",
  "sendTurn",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "stopSession",
  "rollbackConversation",
]);

interface CommandRow {
  readonly commandId: string;
  readonly method: string;
  readonly status: "running" | "completed" | "failed";
  readonly responseJson: string | null;
  readonly errorJson: string | null;
}

interface CommandDiagnosticRow {
  readonly commandId: string;
  readonly method: string;
  readonly status: "running" | "completed" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestJson: string | null;
  readonly responseJson: string | null;
  readonly errorJson: string | null;
}

export interface ProviderDaemonCommandLedgerSnapshot {
  readonly commandCount: number;
  readonly completedCommandCount: number;
  readonly failedCommandCount: number;
  readonly runningCommandCount: number;
  readonly recentCompletedCommands: ReadonlyArray<ProviderDaemonCommandDiagnostic>;
  readonly recentRunningCommands: ReadonlyArray<ProviderDaemonCommandDiagnostic>;
  readonly recentFailedCommands: ReadonlyArray<ProviderDaemonCommandDiagnostic>;
}

function normalizeSqlCount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface ProviderDaemonCommandLedger {
  readonly isMutating: (method: ProviderDaemonRpcRequest["method"]) => boolean;
  readonly requireCommandId: (
    request: ProviderDaemonRpcRequestValue,
  ) => ProviderDaemonRpcEnvelopeValue | string;
  readonly runOnce: (
    request: ProviderDaemonRpcRequestValue,
    execute: Effect.Effect<ProviderDaemonRpcEnvelopeValue>,
  ) => Effect.Effect<ProviderDaemonRpcEnvelopeValue>;
  readonly snapshot: Effect.Effect<ProviderDaemonCommandLedgerSnapshot>;
}

function normalizeOwnerKey(ownerKey: string | undefined): string {
  const normalized = (ownerKey ?? "provider-daemon").trim();
  return normalized.length === 0 ? "provider-daemon" : normalized;
}

function commandError(tag: string, message: string): ProviderDaemonRpcEnvelopeValue {
  return {
    ok: false,
    error: {
      tag,
      message,
    },
  };
}

function truncateCommandError(message: string): string {
  return message.length <= 4_000 ? message : `${message.slice(0, 4_000)}...<truncated>`;
}

function storedEnvelopeError(errorJson: string | null): {
  readonly tag?: string;
  readonly message?: string;
} {
  if (errorJson === null) {
    return {};
  }
  try {
    const envelope = decodeProviderDaemonRpcEnvelopeJson(errorJson);
    return envelope.ok
      ? {}
      : {
          tag: envelope.error.tag,
          message: envelope.error.message,
        };
  } catch {
    return {};
  }
}

function durationMs(createdAt: string, updatedAt: string): number | undefined {
  const startedAtMs = Date.parse(createdAt);
  const finishedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs)) {
    return undefined;
  }
  return Math.max(0, Math.round((finishedAtMs - startedAtMs) * 100) / 100);
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readArrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function readResumeCursorThreadId(value: unknown): string | undefined {
  const resumeCursor = readObject(value);
  return readStringField(resumeCursor, "threadId");
}

function readModelSelectionSummary(value: unknown): Record<string, unknown> | undefined {
  const modelSelection = readObject(value);
  if (!modelSelection) {
    return undefined;
  }
  const options = Array.isArray(modelSelection["options"])
    ? (modelSelection["options"] as ReadonlyArray<unknown>)
    : [];
  const optionSummaries: Array<Record<string, unknown>> = [];
  for (const option of options) {
    const optionRecord = readObject(option);
    const id = readStringField(optionRecord, "id");
    const optionValue = optionRecord?.["value"];
    if (!id || optionValue === undefined) {
      continue;
    }
    const summary: Record<string, unknown> = {
      id,
      valueType: typeof optionValue,
    };
    if (typeof optionValue === "string" || typeof optionValue === "boolean") {
      summary.value = optionValue;
    }
    optionSummaries.push(summary);
  }
  return {
    ...(readStringField(modelSelection, "instanceId") !== undefined
      ? { instanceId: readStringField(modelSelection, "instanceId") }
      : {}),
    ...(readStringField(modelSelection, "model") !== undefined
      ? { model: readStringField(modelSelection, "model") }
      : {}),
    ...(optionSummaries.length > 0 ? { options: optionSummaries } : {}),
  };
}

function storedRequestSummary(requestJson: string | null): Record<string, unknown> | undefined {
  if (requestJson === null) {
    return undefined;
  }
  try {
    const request = decodeProviderDaemonRpcRequestJson(requestJson);
    const payload = readObject("payload" in request ? request.payload : undefined);
    const input = readStringField(payload, "input");
    const modelSelection = readModelSelectionSummary(payload?.["modelSelection"]);
    return {
      method: request.method,
      ...("commandId" in request && request.commandId !== undefined
        ? { commandId: request.commandId }
        : {}),
      ...(readStringField(payload, "threadId") !== undefined
        ? { threadId: readStringField(payload, "threadId") }
        : {}),
      ...(readStringField(payload, "provider") !== undefined
        ? { provider: readStringField(payload, "provider") }
        : {}),
      ...(readStringField(payload, "providerInstanceId") !== undefined
        ? { providerInstanceId: readStringField(payload, "providerInstanceId") }
        : {}),
      ...(readStringField(payload, "runtimeMode") !== undefined
        ? { runtimeMode: readStringField(payload, "runtimeMode") }
        : {}),
      ...(readStringField(payload, "interactionMode") !== undefined
        ? { interactionMode: readStringField(payload, "interactionMode") }
        : {}),
      ...(input !== undefined ? { inputByteLength: Buffer.byteLength(input, "utf8") } : {}),
      ...(readArrayLength(payload?.["attachments"]) !== undefined
        ? { attachmentCount: readArrayLength(payload?.["attachments"]) }
        : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(payload?.["resumeCursor"] === undefined
        ? {}
        : {
            hasResumeCursor: true,
            ...(readResumeCursorThreadId(payload["resumeCursor"]) !== undefined
              ? { resumeCursorThreadId: readResumeCursorThreadId(payload["resumeCursor"]) }
              : {}),
          }),
      ...(readStringField(payload, "requestId") !== undefined
        ? { requestId: readStringField(payload, "requestId") }
        : {}),
      ...(readStringField(payload, "turnId") !== undefined
        ? { turnId: readStringField(payload, "turnId") }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function storedResponseSummary(responseJson: string | null): Record<string, unknown> | undefined {
  if (responseJson === null) {
    return undefined;
  }
  try {
    const envelope = decodeProviderDaemonRpcEnvelopeJson(responseJson);
    if (!envelope.ok) {
      return {
        ok: false,
        tag: envelope.error.tag,
        message: envelope.error.message,
      };
    }
    const value = readObject(envelope.value);
    if (!value) {
      return { ok: true };
    }
    return {
      ok: true,
      ...(readStringField(value, "threadId") !== undefined
        ? { threadId: readStringField(value, "threadId") }
        : {}),
      ...(readStringField(value, "turnId") !== undefined
        ? { turnId: readStringField(value, "turnId") }
        : {}),
      ...(readStringField(value, "provider") !== undefined
        ? { provider: readStringField(value, "provider") }
        : {}),
      ...(readStringField(value, "providerInstanceId") !== undefined
        ? { providerInstanceId: readStringField(value, "providerInstanceId") }
        : {}),
      ...(readStringField(value, "status") !== undefined
        ? { status: readStringField(value, "status") }
        : {}),
      ...(readStringField(value, "model") !== undefined
        ? { model: readStringField(value, "model") }
        : {}),
      ...(value["resumeCursor"] === undefined
        ? {}
        : {
            hasResumeCursor: true,
            ...(readResumeCursorThreadId(value["resumeCursor"]) !== undefined
              ? { resumeCursorThreadId: readResumeCursorThreadId(value["resumeCursor"]) }
              : {}),
          }),
    };
  } catch {
    return undefined;
  }
}

function toCommandDiagnostic(row: CommandDiagnosticRow): ProviderDaemonCommandDiagnostic {
  const error = storedEnvelopeError(row.errorJson);
  const commandDurationMs = durationMs(row.createdAt, row.updatedAt);
  const requestSummary = storedRequestSummary(row.requestJson);
  const responseSummary = storedResponseSummary(row.responseJson);
  return {
    commandId: row.commandId,
    method: row.method,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(commandDurationMs === undefined ? {} : { durationMs: commandDurationMs }),
    ...(requestSummary === undefined ? {} : { requestSummary }),
    ...(responseSummary === undefined ? {} : { responseSummary }),
    ...(error.tag === undefined ? {} : { errorTag: error.tag }),
    ...(error.message === undefined ? {} : { errorMessage: error.message }),
  };
}

export const makeProviderDaemonCommandLedger = (options?: {
  readonly ownerKey?: string;
}): Effect.Effect<ProviderDaemonCommandLedger, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ownerKey = normalizeOwnerKey(options?.ownerKey);
    const ownerCommandPrefix = `${ownerKey}:`;
    const ownerCommandLike = `${ownerCommandPrefix}%`;

    const storageCommandId = (commandId: string): string => `${ownerCommandPrefix}${commandId}`;

    const abandonedEnvelopeJson = encodeProviderDaemonRpcEnvelopeJson(
      commandError(
        "ProviderDaemonCommandAbandonedOnStartup",
        `Command was still running when '${ownerKey}' command ledger started and was marked failed. Provider runtime state is recovered separately from the durable session tables.`,
      ),
    );
    const startupCleanupAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE provider_daemon_commands
      SET
        status = 'failed',
        error_json = ${abandonedEnvelopeJson},
        updated_at = ${startupCleanupAt}
      WHERE command_id LIKE ${ownerCommandLike}
        AND status = 'running'
    `.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider daemon command ledger failed startup cleanup", {
          ownerKey,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.orDie,
    );

    const readCommand = (commandId: string): Effect.Effect<CommandRow | null> =>
      Effect.gen(function* () {
        const storedCommandId = storageCommandId(commandId);
        const rows = (yield* sql`
        SELECT
          command_id AS "commandId",
          method,
          status,
          response_json AS "responseJson",
          error_json AS "errorJson"
        FROM provider_daemon_commands
        WHERE command_id = ${storedCommandId}
        LIMIT 1
      `) as unknown as ReadonlyArray<CommandRow>;
        return rows[0] ?? null;
      }).pipe(Effect.orDie);

    const commandLedgerPersistenceError = (
      operation: string,
      cause: Cause.Cause<unknown>,
    ): Effect.Effect<ProviderDaemonRpcEnvelopeValue> =>
      Effect.logError("provider daemon command ledger persistence failed", {
        ownerKey,
        operation,
        cause: Cause.pretty(cause),
      }).pipe(
        Effect.as(
          commandError(
            "ProviderDaemonCommandLedgerPersistenceFailed",
            truncateCommandError(Cause.pretty(cause)),
          ),
        ),
      );

    const requireCommandId = (
      request: ProviderDaemonRpcRequestValue,
    ): ProviderDaemonRpcEnvelopeValue | string =>
      !MUTATING_METHODS.has(request.method)
        ? ""
        : !("commandId" in request) || request.commandId === undefined
          ? commandError(
              "ProviderDaemonMissingCommandId",
              `Mutating provider daemon RPC '${request.method}' requires commandId.`,
            )
          : request.commandId;

    const runOnce = (
      request: ProviderDaemonRpcRequestValue,
      execute: Effect.Effect<ProviderDaemonRpcEnvelopeValue>,
    ): Effect.Effect<ProviderDaemonRpcEnvelopeValue> =>
      Effect.gen(function* () {
        if (!MUTATING_METHODS.has(request.method)) {
          return yield* execute;
        }

        const commandId = requireCommandId(request);
        if (typeof commandId !== "string") {
          return commandId;
        }
        const storedCommandId = storageCommandId(commandId);
        const existingExit = yield* Effect.exit(readCommand(commandId));
        if (Exit.isFailure(existingExit)) {
          return yield* commandLedgerPersistenceError("readCommand", existingExit.cause);
        }
        const existing = existingExit.value;
        if (existing !== null) {
          if (existing.status === "completed" && existing.responseJson !== null) {
            return decodeProviderDaemonRpcEnvelopeJson(existing.responseJson);
          }
          if (existing.status === "failed" && existing.errorJson !== null) {
            return decodeProviderDaemonRpcEnvelopeJson(existing.errorJson);
          }
          return commandError(
            "ProviderDaemonCommandAlreadyRunning",
            `Command '${commandId}' is already running.`,
          );
        }

        const now = DateTime.formatIso(yield* DateTime.now);
        const insertExit = yield* Effect.exit(sql`
        INSERT INTO provider_daemon_commands (
          command_id,
          method,
          status,
          request_json,
          created_at,
          updated_at
        )
        VALUES (
          ${storedCommandId},
          ${request.method},
          'running',
          ${encodeProviderDaemonRpcRequestJson(request)},
          ${now},
          ${now}
        )
      `);
        if (Exit.isFailure(insertExit)) {
          return yield* commandLedgerPersistenceError("insertRunningCommand", insertExit.cause);
        }

        const executeExit = yield* Effect.exit(execute);
        const envelope = Exit.isSuccess(executeExit)
          ? executeExit.value
          : commandError(
              "ProviderDaemonCommandExecutionFailed",
              truncateCommandError(Cause.pretty(executeExit.cause)),
            );
        if (Exit.isFailure(executeExit)) {
          yield* Effect.logError("provider daemon command execution failed", {
            ownerKey,
            commandId: storedCommandId,
            method: request.method,
            cause: Cause.pretty(executeExit.cause),
          });
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const updateExit = yield* Effect.exit(
          envelope.ok
            ? sql`
          UPDATE provider_daemon_commands
          SET
            status = 'completed',
            response_json = ${encodeProviderDaemonRpcEnvelopeJson(envelope)},
            updated_at = ${updatedAt}
          WHERE command_id = ${storedCommandId}
        `
            : sql`
          UPDATE provider_daemon_commands
          SET
            status = 'failed',
            error_json = ${encodeProviderDaemonRpcEnvelopeJson(envelope)},
            updated_at = ${updatedAt}
          WHERE command_id = ${storedCommandId}
        `,
        );
        if (Exit.isFailure(updateExit)) {
          return yield* commandLedgerPersistenceError("persistCommandOutcome", updateExit.cause);
        }
        return envelope;
      });

    const snapshot: Effect.Effect<ProviderDaemonCommandLedgerSnapshot> = Effect.gen(function* () {
      const rows = (yield* sql`
      SELECT
        COUNT(*) AS "commandCount",
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS "completedCommandCount",
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS "failedCommandCount",
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS "runningCommandCount"
      FROM provider_daemon_commands
      WHERE command_id LIKE ${ownerCommandLike}
    `.pipe(Effect.orDie)) as unknown as ReadonlyArray<ProviderDaemonCommandLedgerSnapshot>;
      const recentRunningRows = (yield* sql`
      SELECT
        command_id AS "commandId",
        method,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        request_json AS "requestJson",
        response_json AS "responseJson",
        error_json AS "errorJson"
      FROM provider_daemon_commands
      WHERE command_id LIKE ${ownerCommandLike}
        AND status = 'running'
      ORDER BY created_at DESC
      LIMIT 10
    `.pipe(Effect.orDie)) as unknown as ReadonlyArray<CommandDiagnosticRow>;
      const recentCompletedRows = (yield* sql`
      SELECT
        command_id AS "commandId",
        method,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        request_json AS "requestJson",
        response_json AS "responseJson",
        error_json AS "errorJson"
      FROM provider_daemon_commands
      WHERE command_id LIKE ${ownerCommandLike}
        AND status = 'completed'
      ORDER BY updated_at DESC
      LIMIT 10
    `.pipe(Effect.orDie)) as unknown as ReadonlyArray<CommandDiagnosticRow>;
      const recentFailedRows = (yield* sql`
      SELECT
        command_id AS "commandId",
        method,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        request_json AS "requestJson",
        response_json AS "responseJson",
        error_json AS "errorJson"
      FROM provider_daemon_commands
      WHERE command_id LIKE ${ownerCommandLike}
        AND status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 10
    `.pipe(Effect.orDie)) as unknown as ReadonlyArray<CommandDiagnosticRow>;
      return {
        commandCount: normalizeSqlCount(rows[0]?.commandCount),
        completedCommandCount: normalizeSqlCount(rows[0]?.completedCommandCount),
        failedCommandCount: normalizeSqlCount(rows[0]?.failedCommandCount),
        runningCommandCount: normalizeSqlCount(rows[0]?.runningCommandCount),
        recentCompletedCommands: recentCompletedRows.map(toCommandDiagnostic),
        recentRunningCommands: recentRunningRows.map(toCommandDiagnostic),
        recentFailedCommands: recentFailedRows.map(toCommandDiagnostic),
      };
    });

    return {
      isMutating: (method: ProviderDaemonRpcRequest["method"]) => MUTATING_METHODS.has(method),
      requireCommandId,
      runOnce,
      snapshot,
    };
  }).pipe(Effect.orDie);
