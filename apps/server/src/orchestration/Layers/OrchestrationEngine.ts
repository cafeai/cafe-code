import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@cafecode/contracts";
import { OrchestrationCommand, ThreadTurnStartRequestedPayload } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { haveSameAttachmentContent } from "../../attachmentContentCommitment.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
  OrchestrationThreadHardDeleteError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import {
  codexTransientAcceptanceCommandId,
  makeRuntimeRecoveryBarrierReader,
} from "../providerRuntimeRecovery.ts";
import {
  markScheduledFollowUpAdmitted,
  verifyScheduledFollowUpAdmission,
} from "../../scheduledFollowups/authorization.ts";
import {
  hydrateLegacyMessageIdentitiesForThread,
  readLatestMessageIdentity,
  type PersistedMessageIdentity,
} from "../messageIdentityLedger.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { SESSION_LIFECYCLE_SUPERSEDED } from "../sessionLifecycle.ts";
import { purgeHardDeletedThreadPersistence } from "../threadHardDelete.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { readThreadForkSourceVersion } from "../threadForkSourceVersion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  readonly kind: "command";
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

type UserTurnMessageCommand =
  | Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>
  | Extract<OrchestrationCommand, { readonly type: "thread.turn.steer" }>;

interface PersistedSequenceRow {
  readonly sequence: number;
}

function isUserTurnMessageCommand(
  command: OrchestrationCommand,
): command is UserTurnMessageCommand {
  return command.type === "thread.turn.start" || command.type === "thread.turn.steer";
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseRecordJson(value: string): Readonly<Record<string, unknown>> | null {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

interface RetryAttachmentIdentity {
  readonly type: "image" | "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

function readRetryAttachmentIdentity(value: unknown): RetryAttachmentIdentity | null {
  const record = readRecord(value);
  if (
    (record?.type !== "image" && record?.type !== "file") ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.sizeBytes !== "number"
  ) {
    return null;
  }
  return {
    type: record.type,
    id: record.id,
    name: record.name,
    mimeType: record.mimeType.toLowerCase(),
    sizeBytes: record.sizeBytes,
  };
}

/**
 * Bind stable message fields and pair the old/new server attachment handles.
 * Image reload recovery assigns a fresh storage id, while generic files can
 * retain the original upload handle. Both variants require the same exact
 * type/name/MIME/size identity and private byte commitments, even when their
 * ids are equal. Otherwise a compact/review rejection can strand an unchanged
 * generic attachment, or a same-byte file can be substituted for an image.
 */
function readMatchingRetryAttachmentPairs(
  command: UserTurnMessageCommand,
  persistedPayloadJson: string,
): ReadonlyArray<{
  readonly original: RetryAttachmentIdentity;
  readonly retry: RetryAttachmentIdentity;
}> | null {
  const payload = parseRecordJson(persistedPayloadJson);
  if (payload?.role !== "user" || payload.text !== command.message.text) {
    return null;
  }

  const persistedAttachmentsRaw = payload.attachments ?? [];
  if (!Array.isArray(persistedAttachmentsRaw)) {
    return null;
  }
  const persistedAttachments = persistedAttachmentsRaw.map(readRetryAttachmentIdentity);
  if (persistedAttachments.some((attachment) => attachment === null)) {
    return null;
  }
  if (persistedAttachments.length !== command.message.attachments.length) {
    return null;
  }

  const pairs = command.message.attachments.map((attachment, index) => {
    const persisted = persistedAttachments[index];
    const retry = readRetryAttachmentIdentity(attachment);
    if (
      persisted === null ||
      persisted === undefined ||
      retry === null ||
      persisted.type !== retry.type ||
      persisted.name !== retry.name ||
      persisted.mimeType !== retry.mimeType ||
      persisted.sizeBytes !== retry.sizeBytes
    ) {
      return null;
    }
    return { original: persisted, retry } as const;
  });
  return pairs.some((pair) => pair === null)
    ? null
    : (pairs as ReadonlyArray<{
        readonly original: RetryAttachmentIdentity;
        readonly retry: RetryAttachmentIdentity;
      }>);
}

interface RetireThreadForHardDeleteEnvelope {
  readonly kind: "retire-thread-for-hard-delete";
  readonly threadId: ThreadId;
  readonly result: Deferred.Deferred<void, OrchestrationThreadHardDeleteError>;
}

interface PurgeHardDeletedThreadEnvelope {
  readonly kind: "purge-hard-deleted-thread";
  readonly threadId: ThreadId;
  readonly result: Deferred.Deferred<
    { readonly deleted: true },
    OrchestrationThreadHardDeleteError
  >;
}

type EngineEnvelope =
  | CommandEnvelope
  | RetireThreadForHardDeleteEnvelope
  | PurgeHardDeletedThreadEnvelope;

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "thread.duplicate":
    case "thread.fork":
    case "thread.fork.commit":
      return {
        aggregateKind: "thread",
        aggregateId: command.targetThreadId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const readRuntimeRecoveryBarrier = yield* makeRuntimeRecoveryBarrierReader;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<EngineEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  // Contains only hard deletes whose projection rows have not yet been
  // purged (including a crash between retire and purge). This bounded-by-live-
  // projections set prevents receipt replay from reporting an old accepted
  // command after the retirement envelope has linearized.
  const hardDeleteRetiringThreadIds = new Set<string>();
  const commandCounters = yield* Ref.make({
    acceptedCommandCount: 0,
    rejectedCommandCount: 0,
    failedCommandCount: 0,
  });

  const assertUserMessageIdentityAvailable = Effect.fn(
    "OrchestrationEngine.assertUserMessageIdentityAvailable",
  )(function* (command: UserTurnMessageCommand) {
    // A terminal steer recovery is server-authored and intentionally reuses
    // the original canonical message. Client schemas cannot author this guard.
    if (command.type === "thread.turn.steer" && command.terminalRecovery !== undefined) {
      return;
    }

    // The command read model caps messages for memory safety and checkpoint
    // revert can remove rows from the detail projection. The append-only event
    // stream remains authoritative, while migration 68's compact sequence
    // ledger keeps normal admission independent of total event-store size.
    // Existing installations are hydrated one selected thread at a time only
    // after readiness, never by a database-wide startup migration.
    const readIdentity = readLatestMessageIdentity(sql, {
      threadId: command.threadId,
      messageId: command.message.messageId,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationEngine.assertUserMessageIdentityAvailable:read"),
      ),
    );
    let existing: PersistedMessageIdentity | undefined = yield* readIdentity;
    if (
      existing === undefined &&
      commandReadModel.threads.some((thread) => thread.id === command.threadId)
    ) {
      yield* hydrateLegacyMessageIdentitiesForThread(sql, command.threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEngine.assertUserMessageIdentityAvailable:hydrate"),
        ),
      );
      existing = yield* readIdentity;
    }
    if (existing === undefined) {
      return;
    }

    const attachmentPairs = readMatchingRetryAttachmentPairs(command, existing.payloadJson);
    if (attachmentPairs === null) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Message identity is already bound to different content in this thread.",
      });
    }

    // Metadata equality is insufficient: different files can share a name,
    // MIME, and byte count. Both ids must have private commitments recorded by
    // Cafe's authenticated upload normalizer, and every digest must match. Old
    // rows intentionally have no backfilled commitment and therefore fail
    // closed rather than trusting mutable files after the fact.
    const attachmentContentMatches = yield* Effect.forEach(
      attachmentPairs,
      ({ original, retry }) =>
        haveSameAttachmentContent(sql, {
          threadId: command.threadId,
          originalAttachmentId: original.id,
          originalSizeBytes: original.sizeBytes,
          retryAttachmentId: retry.id,
          retrySizeBytes: retry.sizeBytes,
        }),
      { concurrency: 1 },
    );
    if (attachmentContentMatches.some((matches) => !matches)) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Message identity is already bound to different content in this thread.",
      });
    }

    // A new command id may reuse the canonical message only after Cafe itself
    // records that the prior Codex steer is queued for retry. Requiring the
    // marker to be newer than the latest message event consumes the authority
    // exactly once: after a retry is accepted, an older failure cannot license
    // another replay.
    const retryableFailureRows = yield* sql<PersistedSequenceRow>`
      SELECT sequence
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${command.threadId}
        AND event_type = 'thread.activity-appended'
        AND actor_kind = 'server'
        AND sequence > ${existing.sequence}
        AND json_extract(payload_json, '$.activity.kind') = 'provider.turn.steer.failed'
        AND json_extract(payload_json, '$.activity.payload.messageId') = ${command.message.messageId}
        AND json_extract(payload_json, '$.activity.payload.retryableFollowUp') = 1
      ORDER BY sequence DESC
      LIMIT 1
    `;
    const retryableFailure = retryableFailureRows[0];
    if (retryableFailure === undefined) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Message identity has already been used in this thread.",
      });
    }

    // Accepted is a provider ACK; recovered and delivered cover the two
    // terminal-boundary completion paths. Any of them consumes the retryable
    // failure and prevents an old marker from authorizing a duplicate send.
    const successfulReceiptRows = yield* sql<PersistedSequenceRow>`
      SELECT sequence
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${command.threadId}
        AND event_type = 'thread.activity-appended'
        AND actor_kind = 'server'
        AND sequence > ${retryableFailure.sequence}
        AND json_extract(payload_json, '$.activity.payload.messageId') = ${command.message.messageId}
        AND json_extract(payload_json, '$.activity.kind') IN (
          'provider.turn.steer.accepted',
          'provider.turn.steer.recovered',
          'provider.turn.steer.delivered'
        )
      ORDER BY sequence ASC
      LIMIT 1
    `;
    if (successfulReceiptRows.length > 0) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Message identity was already delivered to the provider.",
      });
    }
  });

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        if (
          aggregateRef.aggregateKind === "thread" &&
          hardDeleteRetiringThreadIds.has(String(aggregateRef.aggregateId))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: "Thread identity is permanently retired.",
          });
        }

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        if (isUserTurnMessageCommand(envelope.command)) {
          yield* assertUserMessageIdentityAvailable(envelope.command);
        }

        if (
          envelope.command.type === "thread.session.set" &&
          envelope.command.requiresNoPendingTurnStart === true
        ) {
          // An unscoped native watch can observe an idle lifecycle tuple before
          // an automatic continuation is admitted, then wait in this queue.
          // Unlike ordinary turn starts, that continuation can leave the tuple
          // unchanged while its pending message is durable. Recheck the exact
          // pending projection here, inside the same serial worker that commits
          // the session update, so an old watch cannot consume that new intent.
          // Receipt lookup deliberately precedes this admission-only condition:
          // a previously accepted command must replay its receipt, not mutate
          // the session again or reinterpret a newer pending turn as its own.
          const pendingTurnStarts = yield* sql<{ readonly present: number }>`
            SELECT 1 AS "present"
            FROM projection_turns
              INDEXED BY idx_projection_turns_thread_requested
            WHERE thread_id = ${envelope.command.threadId}
              AND turn_id IS NULL
              AND state = 'pending'
              AND pending_message_id IS NOT NULL
              AND checkpoint_turn_count IS NULL
            ORDER BY requested_at DESC
            LIMIT 1
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError("OrchestrationEngine.processEnvelope:pendingTurnStart"),
            ),
          );
          if (pendingTurnStarts.length > 0) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: SESSION_LIFECYCLE_SUPERSEDED,
            });
          }
        }

        // Serialized command admission linearizes this durable check before
        // any later Stop/start/settings command. The provider reactor repeats
        // it immediately before I/O, covering controls accepted after this
        // intent commits while the provider side effect is still pending.
        const runtimeRecoveryBarrierVerified =
          envelope.command.type === "thread.turn.start" &&
          envelope.command.runtimeRecovery !== undefined
            ? yield* readRuntimeRecoveryBarrier({
                ...envelope.command.runtimeRecovery,
                threadId: envelope.command.threadId,
              })
            : false;
        if (
          envelope.command.type === "thread.session.set" &&
          envelope.command.expectedTurnStartIntentSequence !== undefined
        ) {
          // A reactor's earlier read cannot fence a Stop accepted while this
          // failure update waited in the command queue. In particular, stopping
          // a session need not mutate its lifecycle tuple immediately. Compare
          // the latest exact durable intent here, in the same serialized worker
          // that decides and commits the update, before emitting any event.
          const [latestControl] = yield* sql<{
            sequence: number;
            event_type: string;
          }>`
            SELECT sequence, event_type
            FROM orchestration_runtime_recovery_controls
              INDEXED BY idx_runtime_recovery_controls_thread_sequence
            WHERE thread_id = ${envelope.command.threadId}
            ORDER BY sequence DESC
            LIMIT 1
          `.pipe(
            Effect.mapError(
              toPersistenceSqlError("OrchestrationEngine.processEnvelope:turnStartIntent"),
            ),
          );
          if (
            latestControl?.sequence !== envelope.command.expectedTurnStartIntentSequence ||
            latestControl.event_type !== "thread.turn-start-requested"
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail: SESSION_LIFECYCLE_SUPERSEDED,
            });
          }
        }
        let codexFailedRootVerified = false;
        if (
          envelope.command.type === "thread.session.set" &&
          envelope.command.codexFailedRoot !== undefined
        ) {
          const command = envelope.command;
          const failed = command.codexFailedRoot!;
          // Verify immutable receipt authority inside the same serial boundary
          // as the lifecycle CAS. Provider warning content, an ACK projection,
          // or a caller-selected pending message never grants this association.
          const rows = yield* sql<{ readonly payloadJson: string }>`
            SELECT intent.payload_json AS "payloadJson" FROM orchestration_events AS intent
            JOIN orchestration_events AS attempt ON attempt.command_id = ${`server:runtime-recovery-attempt:${failed.intentSequence}`}
            JOIN orchestration_events AS receipt ON receipt.command_id = ${codexTransientAcceptanceCommandId(command.threadId, failed.turnId)}
            WHERE intent.sequence = ${failed.intentSequence} AND intent.aggregate_kind = 'thread'
              AND intent.stream_id = ${command.threadId} AND intent.actor_kind = 'server'
              AND intent.event_type = 'thread.turn-start-requested'
              AND attempt.aggregate_kind = 'thread' AND attempt.stream_id = ${command.threadId}
              AND attempt.actor_kind = 'server' AND attempt.event_type = 'thread.activity-appended'
              AND json_extract(attempt.payload_json, '$.activity.kind') = 'runtime.warning'
              AND json_extract(attempt.payload_json, '$.activity.turnId') = ${failed.previousTurnId}
              AND json_extract(attempt.payload_json, '$.activity.payload.recovery') = 'codex-transient-continuation-attempted'
              AND json_extract(attempt.payload_json, '$.activity.payload.sourceEventSequence') = json_extract(intent.payload_json, '$.runtimeRecovery.sourceEventSequence')
              AND json_type(attempt.payload_json, '$.activity.payload.attemptOwnerId') = 'text'
              AND receipt.aggregate_kind = 'thread' AND receipt.stream_id = ${command.threadId}
              AND receipt.actor_kind = 'server' AND receipt.event_type = 'thread.activity-appended'
              AND json_extract(receipt.payload_json, '$.activity.kind') = 'runtime.warning'
              AND json_extract(receipt.payload_json, '$.activity.turnId') = ${failed.turnId}
              AND json_extract(receipt.payload_json, '$.activity.payload.recovery') = 'codex-transient-continuation-accepted'
              AND json_extract(receipt.payload_json, '$.activity.payload.recoveryIntentSequence') = ${failed.intentSequence}
              AND json_extract(receipt.payload_json, '$.activity.payload.providerInstanceId') = ${command.session.providerInstanceId ?? null}
              AND json_extract(receipt.payload_json, '$.activity.payload.subagentRuntimeId') = ${command.session.subagentRuntimeId ?? null}
              AND json_extract(receipt.payload_json, '$.activity.payload.attemptOwnerId') = json_extract(attempt.payload_json, '$.activity.payload.attemptOwnerId')
              AND EXISTS (SELECT 1 FROM projection_turns WHERE thread_id = ${command.threadId}
                AND pending_message_id = ${failed.messageId} AND (turn_id IS NULL OR turn_id = ${failed.turnId}))
            LIMIT 1
          `.pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEngine.codexFailedRoot")));
          const payload = rows[0] === undefined ? null : parseRecordJson(rows[0].payloadJson);
          if (Schema.is(ThreadTurnStartRequestedPayload)(payload)) {
            const recovery = payload.runtimeRecovery;
            const native = recovery?.codexTransientFailure;
            codexFailedRootVerified =
              payload.threadId === command.threadId &&
              payload.messageId === failed.messageId &&
              payload.createdAt === failed.requestedAt &&
              recovery?.turnId === failed.previousTurnId &&
              native !== undefined &&
              native?.providerInstanceId === command.session.providerInstanceId &&
              native?.subagentRuntimeId === command.session.subagentRuntimeId &&
              (yield* readRuntimeRecoveryBarrier({
                ...recovery!,
                threadId: command.threadId,
                recoveryIntentSequence: failed.intentSequence,
              }));
          }
        }
        let codexRootReplacementVerified = false;
        if (
          envelope.command.type === "thread.session.set" &&
          envelope.command.codexRootReplacement !== undefined
        ) {
          const replacement = envelope.command.codexRootReplacement;
          // This read and the following decider/projector commit share the
          // engine's serial command worker. A control accepted while the
          // provider ACK/inventory was pending therefore wins atomically, not
          // through unreliable comparisons of provider wall-clock timestamps.
          const barriers = yield* projectionSnapshotQuery.getCodexSteerIntentRecoveryBarriers({
            threadId: envelope.command.threadId,
            sequence: replacement.intentSequence,
            messageId: replacement.messageId,
            expectedTurnId: replacement.expectedTurnId,
          });
          codexRootReplacementVerified =
            barriers.intentVerified &&
            !barriers.sessionStopRequested &&
            !barriers.interruptRequested &&
            !barriers.newerTurnRequested;
        }
        const scheduledCommand =
          envelope.command.type === "thread.turn.start" &&
          envelope.command.scheduledFollowUp !== undefined
            ? envelope.command
            : undefined;
        const guardedRevertCommand =
          envelope.command.type === "thread.revert.complete" &&
          envelope.command.expectedControlSequence !== undefined
            ? envelope.command
            : undefined;
        const guardedForkCommand =
          envelope.command.type === "thread.fork.commit" ? envelope.command : undefined;
        const decide = (scheduledFollowUpVerified = false, readModel = commandReadModel) =>
          decideOrchestrationCommand({
            command: envelope.command,
            readModel,
            runtimeRecoveryBarrierVerified,
            codexRootReplacementVerified,
            codexFailedRootVerified,
            scheduledFollowUpVerified,
          });
        // Ordinary commands retain their existing decision boundary. An
        // unattended occurrence additionally claims its exact schedule/run
        // revision inside the event transaction. A concurrent Pause/edit or
        // second backend therefore cannot leave an accepted event without the
        // matching durable authority, or consume authority without its event.
        // Provider-native rewind completion has a separate compare-and-swap:
        // its original revert intent must remain the newest durable control.
        // Defer its decision until that authority is checked under the writer.
        const ordinaryEventBase =
          scheduledCommand === undefined &&
          guardedRevertCommand === undefined &&
          guardedForkCommand === undefined
            ? yield* decide()
            : undefined;
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              let decisionReadModel = commandReadModel;
              if (guardedForkCommand !== undefined) {
                // Reserve the SQLite writer before reading exact source and
                // project authority. This closes same-thread/project races
                // across both queued commands and other database connections.
                yield* sql`UPDATE projection_threads SET updated_at = updated_at
                  WHERE thread_id = ${guardedForkCommand.sourceThreadId}`;
                if (
                  (yield* readThreadForkSourceVersion(sql, guardedForkCommand.sourceThreadId)) !==
                  guardedForkCommand.sourceVersion
                ) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: guardedForkCommand.type,
                    detail: "The source context changed during native fork preparation. Try again.",
                  });
                }
                if (guardedForkCommand.messageCutoff !== undefined) {
                  // Startup deliberately omits transcript/checkpoint bodies.
                  // Read only this bounded source under the same writer/CAS;
                  // an empty command cache is not evidence a message vanished.
                  const messageCount = yield* projectionSnapshotQuery.getThreadForkMessageCount(
                    guardedForkCommand.sourceThreadId,
                  );
                  const source = yield* projectionSnapshotQuery.getThreadDetailById(
                    guardedForkCommand.sourceThreadId,
                  );
                  if (
                    Option.isNone(source) ||
                    messageCount > 2000 ||
                    messageCount !== source.value.messages.length
                  ) {
                    return yield* new OrchestrationCommandInvariantError({
                      commandType: guardedForkCommand.type,
                      detail: "The selected fork has no complete persisted source history.",
                    });
                  }
                  decisionReadModel = {
                    ...commandReadModel,
                    threads: commandReadModel.threads.map((thread) =>
                      thread.id === guardedForkCommand.sourceThreadId ? source.value : thread,
                    ),
                  };
                }
              }
              if (guardedRevertCommand !== undefined) {
                // A deferred SQLite transaction is not yet a writer. Take the
                // writer before reading authority so a second connection cannot
                // accept a prompt, settings change or Stop between this read
                // and publication of the destructive thread.reverted event.
                // This leaves the indexing completeness boundary unchanged.
                yield* sql`UPDATE orchestration_runtime_recovery_control_state
                  SET singleton = singleton WHERE singleton = 1`;
                const [latestControl] = yield* sql<{ sequence: number }>`
                  SELECT sequence FROM orchestration_runtime_recovery_controls
                    INDEXED BY idx_runtime_recovery_controls_thread_sequence
                  WHERE thread_id = ${guardedRevertCommand.threadId}
                  ORDER BY sequence DESC LIMIT 1
                `;
                // Missing authority is a refusal, including expected zero.
                // Receipt replays were handled above and do not repeat this
                // destructive transition after its own event changes the head.
                if (latestControl?.sequence !== guardedRevertCommand.expectedControlSequence) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: guardedRevertCommand.type,
                    detail:
                      "Conversation rewind completion was superseded by a newer thread control.",
                  });
                }
              }
              const eventBase =
                ordinaryEventBase ??
                (yield* decide(
                  scheduledCommand !== undefined &&
                    (yield* verifyScheduledFollowUpAdmission(scheduledCommand).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    )),
                  decisionReadModel,
                ));
              const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = decisionReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                if (
                  savedEvent.type === "thread.turn-start-requested" &&
                  savedEvent.payload.scheduledFollowUp !== undefined
                ) {
                  yield* markScheduledFollowUpAdmitted(savedEvent).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  );
                }
                committedEvents.push(savedEvent);
              }
              if (decisionReadModel !== commandReadModel) {
                // The fork events affect only the target. Do not retain the
                // temporary source body or expand every thread's startup cache.
                nextCommandReadModel = {
                  ...nextCommandReadModel,
                  threads: nextCommandReadModel.threads.map((thread) =>
                    thread.id === guardedForkCommand?.sourceThreadId
                      ? commandReadModel.threads.find((source) => source.id === thread.id)!
                      : thread,
                  ),
                };
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Ref.update(commandCounters, (current) => ({
              ...current,
              acceptedCommandCount: current.acceptedCommandCount + 1,
            }));
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          yield* Ref.update(commandCounters, (current) =>
            isOrchestrationCommandInvariantError(error) ||
            isOrchestrationCommandPreviouslyRejectedError(error)
              ? {
                  ...current,
                  rejectedCommandCount: current.rejectedCommandCount + 1,
                }
              : {
                  ...current,
                  failedCommandCount: current.failedCommandCount + 1,
                },
          );
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  const processRetireThreadForHardDeleteEnvelope = (
    envelope: RetireThreadForHardDeleteEnvelope,
  ): Effect.Effect<void> =>
    Effect.exit(
      Effect.gen(function* () {
        const deletedAt = yield* nowIso;
        yield* sql`
          INSERT INTO hard_deleted_threads (thread_id, deleted_at)
          VALUES (${envelope.threadId}, ${deletedAt})
          ON CONFLICT (thread_id) DO NOTHING
        `;
        hardDeleteRetiringThreadIds.add(String(envelope.threadId));

        // This mutation is deliberately performed by the same single worker
        // that decides commands. Commands queued before this envelope see the
        // old thread; commands queued after it see an absent, permanently
        // retired identity. No timing assumption or external mutex is needed.
        commandReadModel = {
          ...commandReadModel,
          threads: commandReadModel.threads.filter((thread) => thread.id !== envelope.threadId),
          updatedAt: deletedAt,
        };
      }),
    ).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          return Deferred.succeed(envelope.result, undefined).pipe(Effect.asVoid);
        }
        return Deferred.fail(
          envelope.result,
          new OrchestrationThreadHardDeleteError({
            operation: "retire",
            detail: "hard-delete-persistence-failed",
          }),
        ).pipe(Effect.asVoid);
      }),
    );

  const processPurgeHardDeletedThreadEnvelope = (
    envelope: PurgeHardDeletedThreadEnvelope,
  ): Effect.Effect<void> =>
    Effect.exit(
      purgeHardDeletedThreadPersistence({ threadId: envelope.threadId }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    ).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          hardDeleteRetiringThreadIds.delete(String(envelope.threadId));
          return Deferred.succeed(envelope.result, exit.value).pipe(Effect.asVoid);
        }
        return Deferred.fail(
          envelope.result,
          new OrchestrationThreadHardDeleteError({
            operation: "purge",
            detail: "hard-delete-persistence-failed",
          }),
        ).pipe(Effect.asVoid);
      }),
    );

  const processEngineEnvelope = (envelope: EngineEnvelope): Effect.Effect<void> => {
    switch (envelope.kind) {
      case "command":
        return processEnvelope(envelope);
      case "retire-thread-for-hard-delete":
        return processRetireThreadForHardDeleteEnvelope(envelope);
      case "purge-hard-deleted-thread":
        return processPurgeHardDeletedThreadEnvelope(envelope);
    }
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
  const hardDeletedThreadRows = yield* sql<{ readonly threadId: string }>`
    SELECT tombstone.thread_id AS "threadId"
    FROM hard_deleted_threads AS tombstone
    INNER JOIN projection_threads AS thread
      ON thread.thread_id = tombstone.thread_id
  `;
  if (hardDeletedThreadRows.length > 0) {
    const hardDeletedThreadIds = new Set(hardDeletedThreadRows.map((row) => row.threadId));
    for (const threadId of hardDeletedThreadIds) {
      hardDeleteRetiringThreadIds.add(threadId);
    }
    commandReadModel = {
      ...commandReadModel,
      threads: commandReadModel.threads.filter(
        (thread) => !hardDeletedThreadIds.has(String(thread.id)),
      ),
    };
  }

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap(processEngineEnvelope)),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        kind: "command",
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  const retireThreadForHardDelete: OrchestrationEngineShape["retireThreadForHardDelete"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<void, OrchestrationThreadHardDeleteError>();
      yield* Queue.offer(commandQueue, {
        kind: "retire-thread-for-hard-delete",
        threadId: input.threadId,
        result,
      });
      return yield* Deferred.await(result);
    });

  const purgeHardDeletedThread: OrchestrationEngineShape["purgeHardDeletedThread"] = (input) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<
        { readonly deleted: true },
        OrchestrationThreadHardDeleteError
      >();
      yield* Queue.offer(commandQueue, {
        kind: "purge-hard-deleted-thread",
        threadId: input.threadId,
        result,
      });
      return yield* Deferred.await(result);
    });

  const diagnosticsSnapshot: OrchestrationEngineShape["diagnosticsSnapshot"] = Effect.gen(
    function* () {
      const counters = yield* Ref.get(commandCounters);
      const commandQueueDepth = yield* Queue.size(commandQueue);
      return {
        ...counters,
        commandQueueDepth,
        commandReadModelSequence: commandReadModel.snapshotSequence,
      };
    },
  );

  return {
    readEvents,
    dispatch,
    retireThreadForHardDelete,
    purgeHardDeletedThread,
    diagnosticsSnapshot,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
