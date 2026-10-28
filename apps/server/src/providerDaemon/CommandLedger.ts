// Private recovery bindings retain only a process-keyed commitment, never prompt/token bytes.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ProviderDaemonRpcEnvelope,
  ProviderDaemonRpcRequest,
  type ProviderDaemonCommandDiagnostic,
  type ProviderDaemonSessionReconfigurationRefusal,
  type ProviderDaemonFailedRootRetirementRefusal,
  type ProviderDaemonRpcEnvelope as ProviderDaemonRpcEnvelopeValue,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { providerDaemonRequestThreadIds } from "./ProviderDaemonThreadIdentity.ts";

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
  "forkSession",
  "discardSessionFork",
  "sendTurn",
  "prepareFailedRootRecovery",
  "cancelFailedRootRecovery",
  "steerTurn",
  "controlTask",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "snoozeUserInput",
  "stopSession",
  "quiesceThreadForHardDelete",
  "restartProviderRuntime",
  "setGoal",
  "clearGoal",
  "compactThread",
  "rollbackConversation",
  "prepareConversationRollback",
  "commitConversationRollback",
  "finishConversationRollback",
]);

const IDENTITY_BOUND_MUTATING_METHODS = new Set<string>([
  // A refused opening can carry exact-owner retained-policy evidence. A
  // caller-chosen command id cannot lend that receipt to another account,
  // policy, thread or method, even though no replacement was admitted.
  "startSession",
  // Failed-root cold sends can carry a definite pre-submission refusal. Bind
  // every send receipt in both directions so a caller-selected command id
  // cannot lend that witness to changed input, failure identity or another RPC.
  "sendTurn",
  "prepareFailedRootRecovery",
  "cancelFailedRootRecovery",
  "controlTask",
  "prepareConversationRollback",
  "commitConversationRollback",
  "finishConversationRollback",
]);

interface CommandRow {
  readonly commandId: string;
  readonly method: string;
  readonly requestJson: string | null;
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
  readonly sessionReconfigurationRefusal?: ProviderDaemonSessionReconfigurationRefusal;
  readonly failedRootRetirementRefusal?: ProviderDaemonFailedRootRetirementRefusal;
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
          ...(envelope.error.sessionReconfigurationRefusal !== undefined
            ? { sessionReconfigurationRefusal: envelope.error.sessionReconfigurationRefusal }
            : {}),
          ...(envelope.error.failedRootRetirementRefusal !== undefined
            ? { failedRootRetirementRefusal: envelope.error.failedRootRetirementRefusal }
            : {}),
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
      ...(readStringField(payload, "expectedTurnId") !== undefined
        ? { expectedTurnId: readStringField(payload, "expectedTurnId") }
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
  // Private recovery rows retain only fixed unknown outcomes, never paid ACKs.
  // Even legacy private rows cannot project native identities into diagnostics.
  const responseSummary = row.requestJson?.startsWith("private-recovery-v1:")
    ? undefined
    : storedResponseSummary(row.responseJson);
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
    // Content-free semantic admission evidence belongs in the existing bounded
    // health summary as well as the RPC. It never exposes request payloads or
    // grants retry/retirement authority merely because a diagnostic retained it.
    ...(error.sessionReconfigurationRefusal === undefined
      ? {}
      : { sessionReconfigurationRefusal: error.sessionReconfigurationRefusal }),
    ...(error.failedRootRetirementRefusal === undefined
      ? {}
      : { failedRootRetirementRefusal: error.failedRootRetirementRefusal }),
    ...(error.message === undefined ? {} : { errorMessage: error.message }),
  };
}

export const makeProviderDaemonCommandLedger = (options?: {
  readonly ownerKey?: string;
  /** Shared task-control journals retain ambiguous claims across reconnects. */
  readonly recoverAbandonedOnStartup?: boolean;
}): Effect.Effect<ProviderDaemonCommandLedger, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ownerKey = normalizeOwnerKey(options?.ownerKey);
    const ownerCommandPrefix = `${ownerKey}:`;
    const ownerCommandLike = `${ownerCommandPrefix}%`;
    // Deliberately process-local: after restart a matching receipt cannot be
    // authenticated and becomes unknown, never permission to retry.
    const privateBindingKey = randomBytes(32);
    const isPrivateRecovery = (request: ProviderDaemonRpcRequestValue): boolean =>
      request.method === "prepareFailedRootRecovery" ||
      request.method === "cancelFailedRootRecovery" ||
      (request.method === "sendTurn" && request.payload.preparedFailedRootRecovery !== undefined);
    const privateBinding = (request: ProviderDaemonRpcRequestValue): string => {
      const canonical = encodeProviderDaemonRpcRequestJson(request);
      return `private-recovery-v1:${createHmac("sha256", privateBindingKey)
        .update("cafe-provider-daemon-private-recovery-v1\0")
        .update(ownerKey)
        .update("\0")
        .update(canonical)
        .digest("hex")}`;
    };
    const samePrivateBinding = (actual: string | null, expected: string): boolean => {
      if (actual === null || !/^private-recovery-v1:[0-9a-f]{64}(?![\s\S])/u.test(actual))
        return false;
      const left = Buffer.from(actual.slice("private-recovery-v1:".length), "hex");
      const right = Buffer.from(expected.slice("private-recovery-v1:".length), "hex");
      return left.length === right.length && timingSafeEqual(left, right);
    };

    const storageCommandId = (commandId: string): string => `${ownerCommandPrefix}${commandId}`;

    const abandonedEnvelopeJson = encodeProviderDaemonRpcEnvelopeJson(
      commandError(
        "ProviderDaemonCommandAbandonedOnStartup",
        `Command was still running when '${ownerKey}' command ledger started and was marked failed. Provider runtime state is recovered separately from the durable session tables.`,
      ),
    );
    const startupCleanupAt = DateTime.formatIso(yield* DateTime.now);
    if (options?.recoverAbandonedOnStartup !== false)
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
          request_json AS "requestJson",
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

    const hasRetiredThread = (request: ProviderDaemonRpcRequestValue): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        for (const threadId of providerDaemonRequestThreadIds(request)) {
          const rows = yield* sql<{ readonly retired: number }>`
            SELECT 1 AS retired
            FROM hard_deleted_threads
            WHERE thread_id = ${threadId}
            LIMIT 1
          `;
          if (rows.length > 0) {
            return true;
          }
        }
        return false;
      }).pipe(Effect.orDie);

    const retiredThreadEnvelope = (): ProviderDaemonRpcEnvelopeValue =>
      commandError(
        "ProviderDaemonThreadRetired",
        "The requested thread was permanently deleted and cannot accept provider commands.",
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
        // A repeated quiesce request is how a caller safely resumes a bounded
        // legacy purge after a disconnect, so it remains executable after the
        // tombstone exists. Every other thread-scoped mutation is rejected
        // before its prompt-bearing request JSON reaches the ledger.
        if (yield* hasRetiredThread(request)) {
          if (request.method === "quiesceThreadForHardDelete") {
            return yield* execute;
          }
          return retiredThreadEnvelope();
        }
        const privateRecovery = isPrivateRecovery(request);
        // These command ids are generated by the private transport, not a
        // caller-controlled storage channel for a prompt or capability.
        if (
          privateRecovery &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u.test(
            commandId,
          )
        )
          return commandError(
            "ProviderDaemonPrivateRecoveryUnavailable",
            "Private recovery is unavailable or uncertain.",
          );
        const binding = privateRecovery ? privateBinding(request) : undefined;
        const existingExit = yield* Effect.exit(readCommand(commandId));
        if (Exit.isFailure(existingExit)) {
          if (privateRecovery)
            return commandError(
              "ProviderDaemonPrivateRecoveryFailed",
              "Private recovery execution is unavailable or uncertain.",
            );
          return yield* commandLedgerPersistenceError("readCommand", existingExit.cause);
        }
        const existing = existingExit.value;
        if (existing !== null) {
          // A mutation receipt certifies one exact request, not merely a
          // caller-chosen id. Bind both directions: an identity-bound request
          // cannot borrow another method's receipt, nor can another method replay
          // its receipt for a different task, thread or completion proof. Decode
          // and re-encode to compare schema-canonical bodies, not JSON key order.
          if (privateRecovery) {
            if (
              existing.method !== request.method ||
              !binding ||
              !samePrivateBinding(existing.requestJson, binding)
            )
              return commandError(
                "ProviderDaemonCommandIdentityMismatch",
                "The private recovery receipt is unavailable or does not match.",
              );
            // A token-bearing prepare outcome is never reconstructed from the
            // redacted journal; the explicit read-only reservation lookup is
            // the sole way to reconcile a lost preparation acknowledgement.
            if (request.method === "prepareFailedRootRecovery")
              return commandError(
                "ProviderDaemonPrivateRecoveryLookupRequired",
                "Read the exact live recovery reservation to reconcile this command.",
              );
            // Paid calls and exact cancellation are never replayed from this
            // journal. Success may contain unknown provider-owned data; a lost
            // ACK remains an explicitly unknown outcome.
            return commandError(
              "ProviderDaemonPrivateRecoveryOutcomeUnknown",
              "The private recovery outcome must be reconciled without resubmission.",
            );
          } else if (
            IDENTITY_BOUND_MUTATING_METHODS.has(request.method) ||
            IDENTITY_BOUND_MUTATING_METHODS.has(existing.method)
          ) {
            let matches = false;
            try {
              matches =
                existing.method === request.method &&
                existing.requestJson !== null &&
                encodeProviderDaemonRpcRequestJson(
                  decodeProviderDaemonRpcRequestJson(existing.requestJson),
                ) === encodeProviderDaemonRpcRequestJson(request);
            } catch {
              // Missing/corrupt identity cannot certify a cached mutation.
            }
            if (!matches)
              return commandError(
                "ProviderDaemonCommandIdentityMismatch",
                "The mutation receipt does not match this exact request; its outcome is unknown.",
              );
          }
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
        const requestThreadIds = providerDaemonRequestThreadIds(request);
        const insertExit = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
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
                  ${binding ?? encodeProviderDaemonRpcRequestJson(request)},
                  ${now},
                  ${now}
                )
              `;
              for (const threadId of requestThreadIds) {
                yield* sql`
                  INSERT INTO provider_daemon_command_threads (command_id, thread_id)
                  VALUES (${storedCommandId}, ${threadId})
                `;
              }
              yield* sql`
                INSERT INTO provider_daemon_indexed_commands (command_id)
                VALUES (${storedCommandId})
              `;
            }),
          ),
        );
        if (Exit.isFailure(insertExit)) {
          // The permanent fence may have raced the preflight read. Re-check it
          // after SQLite rolls back the body+identity transaction and return a
          // fixed redacted error instead of exposing SQL or request material.
          if (yield* hasRetiredThread(request)) {
            return retiredThreadEnvelope();
          }
          if (privateRecovery)
            return commandError(
              "ProviderDaemonPrivateRecoveryFailed",
              "Private recovery execution is unavailable or uncertain.",
            );
          return yield* commandLedgerPersistenceError("insertRunningCommand", insertExit.cause);
        }

        const executeExit = yield* Effect.exit(execute);
        const envelope = Exit.isSuccess(executeExit)
          ? executeExit.value
          : commandError(
              "ProviderDaemonCommandExecutionFailed",
              privateRecovery
                ? "Private recovery execution is unavailable or uncertain."
                : truncateCommandError(Cause.pretty(executeExit.cause)),
            );
        if (Exit.isFailure(executeExit) && !privateRecovery) {
          yield* Effect.logError("provider daemon command execution failed", {
            ownerKey,
            commandId: storedCommandId,
            method: request.method,
            cause: Cause.pretty(executeExit.cause),
          });
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        // No private result is safe to journal verbatim: even a paid success
        // may contain an opaque provider resume cursor. Keep only a fixed
        // consumed receipt while returning the live ACK to its original caller.
        const storedEnvelope = privateRecovery
          ? commandError(
              "ProviderDaemonPrivateRecoveryOutcomeUnknown",
              "The private outcome must be reconciled without resubmission.",
            )
          : envelope;
        const updateExit = yield* Effect.exit(
          envelope.ok
            ? sql`
          UPDATE provider_daemon_commands
          SET
            status = 'completed',
            response_json = ${encodeProviderDaemonRpcEnvelopeJson(storedEnvelope)},
            updated_at = ${updatedAt}
          WHERE command_id = ${storedCommandId}
        `
            : sql`
          UPDATE provider_daemon_commands
          SET
            status = 'failed',
            error_json = ${encodeProviderDaemonRpcEnvelopeJson(storedEnvelope)},
            updated_at = ${updatedAt}
          WHERE command_id = ${storedCommandId}
        `,
        );
        if (Exit.isFailure(updateExit)) {
          if (privateRecovery)
            return commandError(
              "ProviderDaemonPrivateRecoveryFailed",
              "Private recovery execution is unavailable or uncertain.",
            );
          return yield* commandLedgerPersistenceError("persistCommandOutcome", updateExit.cause);
        }
        return privateRecovery && !envelope.ok ? storedEnvelope : envelope;
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
