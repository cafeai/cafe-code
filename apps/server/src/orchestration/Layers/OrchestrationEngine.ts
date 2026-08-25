import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@cafecode/contracts";
import { OrchestrationCommand } from "@cafecode/contracts";
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
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { purgeHardDeletedThreadPersistence } from "../threadHardDelete.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
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

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
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

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

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
