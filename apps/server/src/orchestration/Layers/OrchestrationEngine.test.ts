import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ChatAttachment,
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  computeAttachmentContentSha256,
  insertAttachmentContentCommitment,
} from "../../attachmentContentCommitment.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    engine,
    sql,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

async function createPersistentOrchestrationSystem(dbPath: string, baseDir: string) {
  const persistenceLayer = makeSqlitePersistenceLive(dbPath);
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), baseDir);
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    engine,
    sql,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getDeletedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getPostTerminalStaleSteerCandidateThreadIds: () => Effect.succeed([]),
          getCodexSteerAcceptanceEvidence: () => Effect.succeed([]),
          getUnsettledCodexSteerIntentEvents: () => Effect.succeed([]),
          getCodexSteerIntentRecoveryBarriers: () => Effect.die("unused"),
          getThreadTurnActivityPage: () => Effect.die("unused"),
          getThreadTurnWorkLogPresence: () => Effect.die("unused"),
          hasThreadTurnSubagentActivity: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("durably routes repeated turn starts while the provider turn is unsettled", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const queuedAttachments = [
      {
        type: "image" as const,
        id: "attachment-follow-up-1",
        name: "follow-up.png",
        mimeType: "image/png",
        sizeBytes: 128,
      },
    ] as unknown as ChatAttachment[];

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-single-flight-create"),
        projectId: asProjectId("project-single-flight"),
        title: "Project Single Flight",
        workspaceRoot: "/tmp/project-single-flight",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-single-flight-create"),
        threadId: ThreadId.make("thread-single-flight"),
        projectId: asProjectId("project-single-flight"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-single-flight-1"),
        threadId: ThreadId.make("thread-single-flight"),
        message: {
          messageId: asMessageId("msg-single-flight-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const snapshotAfterFirstStart = await system.readModel();
    const threadAfterFirstStart = snapshotAfterFirstStart.threads.find(
      (thread) => thread.id === "thread-single-flight",
    );
    expect(threadAfterFirstStart?.session?.status).toBe("starting");

    const materializingFollowUp = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-single-flight-2"),
      threadId: ThreadId.make("thread-single-flight"),
      message: {
        messageId: asMessageId("msg-single-flight-2"),
        role: "user",
        text: "second",
        attachments: queuedAttachments,
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:01.000Z",
    } satisfies OrchestrationCommand;

    await system.run(engine.dispatch(materializingFollowUp));
    // A reconnect can retry the exact command after its response is lost. The
    // durable command receipt must return the prior result without duplicating
    // either the user message or provider intent.
    await system.run(engine.dispatch(materializingFollowUp));

    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-without-active-turn"),
        threadId: ThreadId.make("thread-single-flight"),
        session: {
          threadId: ThreadId.make("thread-single-flight"),
          status: "running",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-running-without-active-turn"),
        threadId: ThreadId.make("thread-single-flight"),
        message: {
          messageId: asMessageId("msg-running-without-active-turn"),
          role: "user",
          text: "third",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thread.turn-steer-requested")).toHaveLength(2);
    expect(
      events
        .filter(
          (event): event is Extract<OrchestrationEvent, { type: "thread.turn-steer-requested" }> =>
            event.type === "thread.turn-steer-requested",
        )
        .map((event) => event.payload.expectedTurnId),
    ).toEqual([null, null]);
    expect(events.filter((event) => event.type === "thread.message-sent")).toHaveLength(3);
    expect(
      events.find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
          event.type === "thread.message-sent" && event.payload.messageId === "msg-single-flight-2",
      )?.payload,
    ).toMatchObject({
      turnId: null,
      attachments: queuedAttachments,
    });
    expect(
      events.find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
          event.type === "thread.message-sent" &&
          event.payload.messageId === "msg-running-without-active-turn",
      )?.payload.turnId,
    ).toBeNull();

    await system.dispose();
  });

  it("binds client MessageIds once while permitting one server-authorized exact steer retry", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.make("thread-message-identity");
    const messageId = asMessageId("message-stable-retry");
    const originalAttachment = {
      type: "image" as const,
      id: "attachment-original",
      name: "evidence.png",
      mimeType: "image/png",
      sizeBytes: 512,
    } as unknown as ChatAttachment;
    const reuploadedAttachment = {
      ...originalAttachment,
      id: "attachment-reuploaded",
      mimeType: "IMAGE/PNG",
    } as unknown as ChatAttachment;
    const changedBytesAttachment = {
      ...originalAttachment,
      id: "attachment-changed-bytes",
    } as unknown as ChatAttachment;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-message-identity"),
        projectId: asProjectId("project-message-identity"),
        title: "Message identity",
        workspaceRoot: "/tmp/project-message-identity",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-message-identity"),
        threadId,
        projectId: asProjectId("project-message-identity"),
        title: "Message identity",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const originalBytes = Buffer.alloc(originalAttachment.sizeBytes, 0x61);
    const changedBytes = Buffer.alloc(originalAttachment.sizeBytes, 0x62);
    await system.run(
      Effect.forEach(
        [originalAttachment, reuploadedAttachment],
        (attachment) =>
          insertAttachmentContentCommitment({
            sql: system.sql,
            attachmentId: attachment.id,
            threadId,
            contentSha256: computeAttachmentContentSha256(originalBytes),
            sizeBytes: attachment.sizeBytes,
          }),
        { concurrency: 1, discard: true },
      ),
    );
    await system.run(
      insertAttachmentContentCommitment({
        sql: system.sql,
        attachmentId: changedBytesAttachment.id,
        threadId,
        contentSha256: computeAttachmentContentSha256(changedBytes),
        sizeBytes: changedBytesAttachment.sizeBytes,
      }),
    );

    const originalCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-message-identity-original"),
      threadId,
      message: {
        messageId,
        role: "user",
        text: "retry this exact input",
        attachments: [originalAttachment],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt: "2026-01-01T00:00:01.000Z",
    } satisfies OrchestrationCommand;
    const first = await system.run(engine.dispatch(originalCommand));
    const exactReceiptReplay = await system.run(engine.dispatch(originalCommand));
    expect(exactReceiptReplay).toEqual(first);

    const unmarkedReuse = await system.run(
      Effect.exit(
        engine.dispatch({
          ...originalCommand,
          commandId: CommandId.make("cmd-message-identity-unmarked-reuse"),
        }),
      ),
    );
    expect(unmarkedReuse._tag).toBe("Failure");

    const changedContentReuse = await system.run(
      Effect.exit(
        engine.dispatch({
          ...originalCommand,
          commandId: CommandId.make("cmd-message-identity-changed-content"),
          message: {
            ...originalCommand.message,
            text: "replace the original input",
          },
        }),
      ),
    );
    expect(changedContentReuse._tag).toBe("Failure");

    await system.run(
      engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("server:message-identity-retryable"),
        threadId,
        activity: {
          id: EventId.make("activity-message-identity-retryable"),
          tone: "info",
          kind: "provider.turn.steer.failed",
          summary: "Provider steer queued",
          payload: {
            provider: "codex",
            messageId,
            retryableFollowUp: true,
          },
          turnId: null,
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    // Equal metadata cannot authorize different image bytes.
    const changedBytesReuse = await system.run(
      Effect.exit(
        engine.dispatch({
          ...originalCommand,
          commandId: CommandId.make("cmd-message-identity-changed-bytes"),
          message: {
            ...originalCommand.message,
            attachments: [changedBytesAttachment],
          },
          createdAt: "2026-01-01T00:00:02.500Z",
        }),
      ),
    );
    expect(changedBytesReuse._tag).toBe("Failure");

    const authorizedRetry = await system.run(
      engine.dispatch({
        ...originalCommand,
        commandId: CommandId.make("cmd-message-identity-authorized-retry"),
        message: {
          ...originalCommand.message,
          attachments: [reuploadedAttachment],
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    expect(authorizedRetry.sequence).toBeGreaterThan(first.sequence);

    // The retry's new message event consumes the older failure marker, so a
    // third command cannot replay the same identity before another failure.
    const consumedMarkerReuse = await system.run(
      Effect.exit(
        engine.dispatch({
          ...originalCommand,
          commandId: CommandId.make("cmd-message-identity-consumed-marker"),
          message: {
            ...originalCommand.message,
            attachments: [reuploadedAttachment],
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      ),
    );
    expect(consumedMarkerReuse._tag).toBe("Failure");

    await system.run(
      engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("server:message-identity-second-retryable"),
        threadId,
        activity: {
          id: EventId.make("activity-message-identity-second-retryable"),
          tone: "info",
          kind: "provider.turn.steer.failed",
          summary: "Provider steer queued",
          payload: {
            provider: "codex",
            messageId,
            retryableFollowUp: true,
          },
          turnId: null,
          createdAt: "2026-01-01T00:00:05.000Z",
        },
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("server:message-identity-delivered"),
        threadId,
        activity: {
          id: EventId.make("activity-message-identity-delivered"),
          tone: "info",
          kind: "provider.turn.steer.delivered",
          summary: "Provider steer delivered",
          payload: {
            provider: "codex",
            messageId,
            delivery: "next-turn",
          },
          turnId: null,
          createdAt: "2026-01-01T00:00:06.000Z",
        },
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );
    const deliveredReuse = await system.run(
      Effect.exit(
        engine.dispatch({
          ...originalCommand,
          commandId: CommandId.make("cmd-message-identity-after-delivery"),
          message: {
            ...originalCommand.message,
            attachments: [reuploadedAttachment],
          },
          createdAt: "2026-01-01T00:00:07.000Z",
        }),
      ),
    );
    expect(deliveredReuse._tag).toBe("Failure");

    // Internal terminal recovery is the only unconditional reuse path. The
    // client schema cannot author terminalRecovery, and the server command is
    // still protected by its deterministic receipt identity.
    const terminalRecovery = await system.run(
      engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("server:message-identity-terminal-recovery"),
        threadId,
        message: {
          ...originalCommand.message,
          attachments: [reuploadedAttachment],
        },
        terminalRecovery: {
          staleTurnId: asTurnId("turn-message-identity-stale"),
        },
        createdAt: "2026-01-01T00:00:08.000Z",
      }),
    );
    expect(terminalRecovery.sequence).toBeGreaterThan(authorizedRetry.sequence);

    await system.dispose();
  });

  it("keeps attachment byte commitments across restart and fails legacy identities closed", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-message-commitment-restart-"));
    const dbPath = path.join(baseDir, "orchestration.sqlite");
    const threadId = ThreadId.make("thread-message-commitment-restart");
    const projectId = asProjectId("project-message-commitment-restart");
    const attachmentBytes = Buffer.from("same immutable attachment bytes", "utf8");
    const makeAttachment = (id: string): ChatAttachment =>
      ({
        type: "image",
        id,
        name: "restart.png",
        mimeType: "image/png",
        sizeBytes: attachmentBytes.byteLength,
      }) as ChatAttachment;
    const originalAttachment = makeAttachment("restart-attachment-original");
    const reuploadedAttachment = makeAttachment("restart-attachment-reuploaded");
    const legacyOriginalAttachment = makeAttachment("restart-attachment-legacy-original");
    const legacyReuploadedAttachment = makeAttachment("restart-attachment-legacy-reuploaded");
    let firstSystem: Awaited<ReturnType<typeof createPersistentOrchestrationSystem>> | undefined;
    let secondSystem: Awaited<ReturnType<typeof createPersistentOrchestrationSystem>> | undefined;

    try {
      firstSystem = await createPersistentOrchestrationSystem(dbPath, baseDir);
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-message-commitment-restart"),
          projectId,
          title: "Message commitment restart",
          workspaceRoot: "/tmp/project-message-commitment-restart",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: now(),
        }),
      );
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-message-commitment-restart"),
          threadId,
          projectId,
          title: "Message commitment restart",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await firstSystem.run(
        insertAttachmentContentCommitment({
          sql: firstSystem.sql,
          attachmentId: originalAttachment.id,
          threadId,
          contentSha256: computeAttachmentContentSha256(attachmentBytes),
          sizeBytes: attachmentBytes.byteLength,
        }),
      );

      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-message-commitment-restart-original"),
          threadId,
          message: {
            messageId: asMessageId("message-commitment-restart"),
            role: "user",
            text: "retry after restart",
            attachments: [originalAttachment],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
      );
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("server:message-commitment-restart-retryable"),
          threadId,
          activity: {
            id: EventId.make("activity-message-commitment-restart-retryable"),
            tone: "info",
            kind: "provider.turn.steer.failed",
            summary: "Provider steer queued",
            payload: {
              provider: "codex",
              messageId: asMessageId("message-commitment-restart"),
              retryableFollowUp: true,
            },
            turnId: null,
            createdAt: "2026-01-01T00:01:01.000Z",
          },
          createdAt: "2026-01-01T00:01:01.000Z",
        }),
      );

      // Simulate an attachment written by an older Cafe build. Its metadata is
      // durable, but no immutable content commitment exists to authorize reuse.
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-message-commitment-legacy-original"),
          threadId,
          message: {
            messageId: asMessageId("message-commitment-legacy"),
            role: "user",
            text: "legacy attachment retry",
            attachments: [legacyOriginalAttachment],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:01:02.000Z",
        }),
      );
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("server:message-commitment-legacy-retryable"),
          threadId,
          activity: {
            id: EventId.make("activity-message-commitment-legacy-retryable"),
            tone: "info",
            kind: "provider.turn.steer.failed",
            summary: "Provider steer queued",
            payload: {
              provider: "codex",
              messageId: asMessageId("message-commitment-legacy"),
              retryableFollowUp: true,
            },
            turnId: null,
            createdAt: "2026-01-01T00:01:03.000Z",
          },
          createdAt: "2026-01-01T00:01:03.000Z",
        }),
      );
      await firstSystem.dispose();
      firstSystem = undefined;

      const restartedSystem = await createPersistentOrchestrationSystem(dbPath, baseDir);
      secondSystem = restartedSystem;
      await restartedSystem.run(
        Effect.forEach(
          [reuploadedAttachment, legacyReuploadedAttachment],
          (attachment) =>
            insertAttachmentContentCommitment({
              sql: restartedSystem.sql,
              attachmentId: attachment.id,
              threadId,
              contentSha256: computeAttachmentContentSha256(attachmentBytes),
              sizeBytes: attachmentBytes.byteLength,
            }),
          { concurrency: 1, discard: true },
        ),
      );

      const recovered = await restartedSystem.run(
        restartedSystem.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-message-commitment-restart-retry"),
          threadId,
          message: {
            messageId: asMessageId("message-commitment-restart"),
            role: "user",
            text: "retry after restart",
            attachments: [reuploadedAttachment],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:01:04.000Z",
        }),
      );
      expect(recovered.sequence).toBeGreaterThan(0);

      const legacyRetry = await restartedSystem.run(
        Effect.exit(
          restartedSystem.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-message-commitment-legacy-retry"),
            threadId,
            message: {
              messageId: asMessageId("message-commitment-legacy"),
              role: "user",
              text: "legacy attachment retry",
              attachments: [legacyReuploadedAttachment],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:01:05.000Z",
          }),
        ),
      );
      expect(legacyRetry._tag).toBe("Failure");
    } finally {
      await firstSystem?.dispose();
      await secondSystem?.dispose();
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("routes a same-provider active turn into a steer but preserves a provider switch", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.make("thread-start-routes-to-steer");
    const activeTurnId = TurnId.make("turn-active");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-start-routes-to-steer-create"),
        projectId: asProjectId("project-start-routes-to-steer"),
        title: "Project Start Routes To Steer",
        workspaceRoot: "/tmp/project-start-routes-to-steer",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-8",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-start-routes-to-steer-create"),
        threadId,
        projectId: asProjectId("project-start-routes-to-steer"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-8",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-start-routes-to-steer"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-routes-to-steer"),
        threadId,
        message: {
          messageId: asMessageId("msg-start-routes-to-steer"),
          role: "user",
          text: "queued while Claude is active",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.filter((event) => event.type === "thread.turn-steer-requested")).toHaveLength(1);
    expect(
      events.find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-steer-requested" }> =>
          event.type === "thread.turn-steer-requested",
      )?.payload.expectedTurnId,
    ).toBe(activeTurnId);
    const routedMessage = events.find(
      (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === "msg-start-routes-to-steer",
    );
    expect(routedMessage?.payload.turnId).toBe(activeTurnId);
    expect(
      events.filter(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> =>
          event.type === "thread.turn-start-requested" &&
          event.payload.messageId === "msg-start-routes-to-steer",
      ),
    ).toHaveLength(0);

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-routes-to-provider-switch"),
        threadId,
        message: {
          messageId: asMessageId("msg-start-routes-to-provider-switch"),
          role: "user",
          text: "switch from Claude to Codex",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    const eventsAfterSwitch = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      eventsAfterSwitch.filter((event) => event.type === "thread.turn-steer-requested"),
    ).toHaveLength(1);
    expect(
      eventsAfterSwitch.find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> =>
          event.type === "thread.turn-start-requested" &&
          event.payload.messageId === "msg-start-routes-to-provider-switch",
      )?.payload,
    ).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
    });
    expect(
      eventsAfterSwitch.find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
          event.type === "thread.message-sent" &&
          event.payload.messageId === "msg-start-routes-to-provider-switch",
      )?.payload.turnId,
    ).toBeNull();

    await system.dispose();
  });

  it("starts a new turn when only a stale latest running turn remains", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.make("thread-stale-latest-running-starts-new-turn");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stale-latest-create"),
        projectId: asProjectId("project-stale-latest"),
        title: "Project Stale Latest",
        workspaceRoot: "/tmp/project-stale-latest",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-stale-latest-create"),
        threadId,
        projectId: asProjectId("project-stale-latest"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-stale-latest-first"),
        threadId,
        message: {
          messageId: asMessageId("msg-stale-latest-first"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-stale-latest-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-stale-latest-second"),
        threadId,
        message: {
          messageId: asMessageId("msg-stale-latest-second"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.filter(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> =>
          event.type === "thread.turn-start-requested",
      ),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-steer-requested" }> =>
          event.type === "thread.turn-steer-requested",
      ),
    ).toHaveLength(0);
    const secondMessage = events.find(
      (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === "msg-stale-latest-second",
    );
    expect(secondMessage?.payload.turnId).toBeNull();

    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("commits a provider-native fork as one same-workspace thread transaction", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = "2026-08-21T12:00:00.000Z";
    const projectId = asProjectId("project-native-fork");
    const sourceThreadId = ThreadId.make("thread-native-fork-source");
    const targetThreadId = ThreadId.make("thread-native-fork-target");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-native-fork-project"),
        projectId,
        title: "Native Fork Project",
        workspaceRoot: "/tmp/native-fork-project",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-native-fork-source"),
        threadId: sourceThreadId,
        projectId,
        title: "Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: "feature/native-fork",
        worktreePath: "/tmp/native-fork-project",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-native-fork-source-turn"),
        threadId: sourceThreadId,
        message: {
          messageId: asMessageId("message-native-fork-source"),
          role: "user",
          text: "Preserve this context",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: "2026-08-21T12:00:00.500Z",
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-native-fork-source-ready"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-21T12:00:00.750Z",
        },
        createdAt: "2026-08-21T12:00:00.750Z",
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.fork.commit",
        commandId: CommandId.make("cmd-native-fork-commit"),
        sourceThreadId,
        targetThreadId,
        title: "Source (fork)",
        createdAt: "2026-08-21T12:00:01.000Z",
        session: {
          threadId: targetThreadId,
          status: "stopped",
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-21T12:00:01.000Z",
        },
      }),
    );

    const snapshot = await system.readModel();
    const source = snapshot.threads.find((thread) => thread.id === sourceThreadId);
    const target = snapshot.threads.find((thread) => thread.id === targetThreadId);
    expect(source?.title).toBe("Source");
    expect(source?.session?.status).toBe("ready");
    expect(target).toMatchObject({
      title: "Source (fork)",
      projectId,
      branch: "feature/native-fork",
      worktreePath: "/tmp/native-fork-project",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      session: {
        threadId: targetThreadId,
        status: "stopped",
        providerName: "codex",
        providerInstanceId: "codex",
      },
    });
    expect(target?.messages).toEqual([
      expect.objectContaining({
        id: "copy:thread-native-fork-target:message-native-fork-source",
        role: "user",
        text: "Preserve this context",
        streaming: false,
      }),
    ]);

    const eventTypes = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((events) => Array.from(events, (event) => event.type)),
      ),
    );
    expect(eventTypes.slice(-3)).toEqual(["thread.created", "thread.forked", "thread.session-set"]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes = await system.run(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(engine.streamDomainEvents);
        const firstPull = yield* Effect.forkChild(pull);
        // The pull fiber acquires the hot PubSub subscription during this deterministic
        // scheduler handoff, before either command can publish its event.
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        const eventTypes = Array.from(yield* Fiber.join(firstPull), (event) => event.type);
        while (eventTypes.length < 2) {
          eventTypes.push(...Array.from(yield* pull, (event) => event.type));
        }
        return eventTypes;
      }).pipe(Effect.scoped),
    );

    expect(Array.from(eventTypes)).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("linearizes hard deletion in the command FIFO and permanently rejects the old identity", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-hard-delete-engine");
    const targetThreadId = ThreadId.make("thread-hard-delete-engine");
    const survivorThreadId = ThreadId.make("thread-hard-delete-survivor");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-hard-delete-project-create"),
        projectId,
        title: "Hard delete project",
        workspaceRoot: "/tmp/project-hard-delete-engine",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    for (const [threadId, suffix] of [
      [targetThreadId, "target"],
      [survivorThreadId, "survivor"],
    ] as const) {
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-hard-delete-thread-create-${suffix}`),
          threadId,
          projectId,
          title: suffix,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
    }

    // This control envelope shares the exact FIFO used by dispatch. Once it
    // resolves, no later command can decide against the stale in-memory thread.
    await system.run(engine.retireThreadForHardDelete({ threadId: targetThreadId }));

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-hard-delete-target-after-fence"),
          threadId: targetThreadId,
          title: "must not return",
        }),
      ),
    ).rejects.toThrow("Thread identity is permanently retired");

    // Even an exact replay of a previously accepted command must reject after
    // the retirement boundary; receipt lookup cannot bypass the fence while
    // file cleanup is running before the purge envelope.
    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-hard-delete-thread-create-target"),
          threadId: targetThreadId,
          projectId,
          title: "target",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("permanently retired");

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-hard-delete-survivor-after-fence"),
        threadId: survivorThreadId,
        title: "survivor updated",
      }),
    );
    await system.run(engine.purgeHardDeletedThread({ threadId: targetThreadId }));

    const snapshot = await system.readModel();
    expect(snapshot.threads.some((thread) => thread.id === targetThreadId)).toBe(false);
    expect(snapshot.threads.find((thread) => thread.id === survivorThreadId)?.title).toBe(
      "survivor updated",
    );

    // The durable tombstone also blocks the only command whose ordinary
    // missing-thread invariant would otherwise permit same-id recreation.
    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-hard-delete-recreate"),
          threadId: targetThreadId,
          projectId,
          title: "recreated",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("Failed to execute OrchestrationEventStore.append:insert");

    const events = await system.run(Stream.runCollect(engine.readEvents(0)));
    expect(Array.from(events).some((event) => event.aggregateId === targetThreadId)).toBe(false);

    await system.dispose();
  });
});
