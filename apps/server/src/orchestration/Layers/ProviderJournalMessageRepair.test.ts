import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderJournalMessageRepair } from "../Services/ProviderJournalMessageRepair.ts";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { ProviderJournalMessageRepairLive } from "./ProviderJournalMessageRepair.ts";

const projectId = ProjectId.make("project-repair");
const threadId = ThreadId.make("thread-repair");
const userMessageId = MessageId.make("user-repair");
const assistantMessageId = MessageId.make("assistant:item-repair");
const turnId = TurnId.make("turn-repair");
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const itemId = RuntimeItemId.make("item-repair");
const now = "2026-01-01T00:00:00.000Z";
const encodeProviderRuntimeEventJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);

const makeRepairTestLayer = (
  prefix: string,
  options?: {
    readonly readThread?: NonNullable<ProviderServiceShape["readThread"]>;
  },
) =>
  ProviderJournalMessageRepairLive.pipe(
    Layer.provideMerge(
      Layer.mock(ProviderService)({
        readThread: options?.readThread ?? (() => Effect.die("unexpected provider readThread")),
      }),
    ),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

type RepairRuntime = ManagedRuntime.ManagedRuntime<
  | ProviderJournalMessageRepair
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | SqlClient.SqlClient,
  never
>;

let runtimes: RepairRuntime[] = [];

async function createHarness(
  prefix: string,
  options?: {
    readonly readThread?: NonNullable<ProviderServiceShape["readThread"]>;
  },
) {
  const runtime = ManagedRuntime.make(makeRepairTestLayer(prefix, options)) as RepairRuntime;
  runtimes.push(runtime);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const repair = await runtime.runPromise(Effect.service(ProviderJournalMessageRepair));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));

  const seedTerminalAssistantMessage = (input?: { streaming?: boolean }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`cmd-${prefix}-project`),
          projectId,
          title: "Repair Project",
          workspaceRoot: "/tmp/repair-project",
          defaultModelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5-codex",
          },
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-${prefix}-thread`),
          threadId,
          projectId,
          title: "Repair Thread",
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-${prefix}-turn-start`),
          threadId,
          message: {
            messageId: userMessageId,
            role: "user",
            text: "repair the old answer",
            attachments: [],
          },
          modelSelection: {
            instanceId: providerInstanceId,
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`cmd-${prefix}-assistant-delta`),
          threadId,
          messageId: assistantMessageId,
          turnId,
          delta: "visible prefix",
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        if (input?.streaming !== true) {
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`cmd-${prefix}-assistant-complete`),
            threadId,
            messageId: assistantMessageId,
            turnId,
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-${prefix}-turn-diff`),
            threadId,
            turnId,
            completedAt: "2026-01-01T00:00:03.000Z",
            checkpointRef: CheckpointRef.make(`checkpoint-${prefix}`),
            status: "ready",
            files: [],
            assistantMessageId,
            checkpointTurnCount: 1,
            createdAt: "2026-01-01T00:00:03.000Z",
          });
        }
      }),
    );

  const insertCompletionEvent = (input: {
    readonly eventId: string;
    readonly completionText: string;
    readonly itemId?: RuntimeItemId;
  }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const event: ProviderRuntimeEventValue = {
          type: "item.completed",
          eventId: EventId.make(input.eventId),
          provider,
          providerInstanceId,
          threadId,
          turnId,
          ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          createdAt: "2026-01-01T00:00:04.000Z",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: input.completionText,
          },
        };
        yield* sql`
          INSERT INTO provider_daemon_events (
            owner_key,
            emitted_at,
            event_json
          )
          VALUES (
            ${"provider-daemon"},
            ${"2026-01-01T00:00:04.000Z"},
            ${encodeProviderRuntimeEventJson(event)}
          )
        `;
      }),
    );

  const readThread = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const snapshot = yield* snapshotQuery.getSnapshot();
        return snapshot.threads.find((thread) => thread.id === threadId);
      }),
    );

  return {
    repair,
    seedTerminalAssistantMessage,
    insertCompletionEvent,
    readThread,
  };
}

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  runtimes = [];
});

describe("ProviderJournalMessageRepair", () => {
  it("repairs a prefix-truncated completed assistant message from a retained journal event", async () => {
    const harness = await createHarness("repair-success");
    await harness.seedTerminalAssistantMessage();
    await harness.insertCompletionEvent({
      eventId: "evt-repair-completed",
      itemId,
      completionText: "visible prefix plus recovered suffix",
    });

    const result = await Effect.runPromise(
      harness.repair.repairAssistantMessage({
        threadId,
        messageId: assistantMessageId,
      }),
    );
    const thread = await harness.readThread();
    const repairedMessage = thread?.messages.find((message) => message.id === assistantMessageId);
    const auditActivity = thread?.activities.find(
      (activity) => activity.kind === "assistant.repair.applied",
    );

    expect(result).toMatchObject({
      status: "repaired",
      oldLength: "visible prefix".length,
      newLength: "visible prefix plus recovered suffix".length,
      appendedLength: " plus recovered suffix".length,
      candidateCount: 1,
      provider,
      providerInstanceId,
      itemId,
      sourceEventId: "evt-repair-completed",
    });
    expect("suffix" in result).toBe(false);
    expect("completionText" in result).toBe(false);
    expect(repairedMessage?.text).toBe("visible prefix plus recovered suffix");
    expect(repairedMessage?.streaming).toBe(false);
    expect(JSON.stringify(auditActivity?.payload ?? {})).not.toContain("recovered suffix");
  });

  it("does not mutate when retained provider text diverges from the projected prefix", async () => {
    const harness = await createHarness("repair-diverged");
    await harness.seedTerminalAssistantMessage();
    await harness.insertCompletionEvent({
      eventId: "evt-repair-diverged",
      itemId,
      completionText: "different provider output",
    });

    const result = await Effect.runPromise(
      harness.repair.repairAssistantMessage({
        threadId,
        messageId: assistantMessageId,
      }),
    );
    const thread = await harness.readThread();
    const message = thread?.messages.find((entry) => entry.id === assistantMessageId);

    expect(result.status).toBe("diverged");
    expect(message?.text).toBe("visible prefix");
    expect(message?.streaming).toBe(false);
  });

  it("does not repair active streaming assistant messages", async () => {
    const harness = await createHarness("repair-streaming");
    await harness.seedTerminalAssistantMessage({ streaming: true });
    await harness.insertCompletionEvent({
      eventId: "evt-repair-streaming",
      itemId,
      completionText: "visible prefix plus recovered suffix",
    });

    const result = await Effect.runPromise(
      harness.repair.repairAssistantMessage({
        threadId,
        messageId: assistantMessageId,
      }),
    );
    const thread = await harness.readThread();
    const message = thread?.messages.find((entry) => entry.id === assistantMessageId);

    expect(result).toMatchObject({
      status: "not-eligible",
      reason: "message-still-streaming",
    });
    expect(message?.text).toBe("visible prefix");
    expect(message?.streaming).toBe(true);
  });

  it("reports ambiguity instead of guessing between multiple prefix-safe retained completions", async () => {
    const harness = await createHarness("repair-ambiguous");
    await harness.seedTerminalAssistantMessage();
    await harness.insertCompletionEvent({
      eventId: "evt-repair-ambiguous-a",
      completionText: "visible prefix first suffix",
    });
    await harness.insertCompletionEvent({
      eventId: "evt-repair-ambiguous-b",
      completionText: "visible prefix second suffix",
    });

    const result = await Effect.runPromise(
      harness.repair.repairAssistantMessage({
        threadId,
        messageId: assistantMessageId,
      }),
    );
    const thread = await harness.readThread();
    const message = thread?.messages.find((entry) => entry.id === assistantMessageId);

    expect(result).toMatchObject({
      status: "ambiguous-source",
      candidateCount: 2,
    });
    expect(message?.text).toBe("visible prefix");
  });

  it("repairs every eligible assistant message in a thread from the local journal first", async () => {
    const harness = await createHarness("repair-thread-local");
    await harness.seedTerminalAssistantMessage();
    await harness.insertCompletionEvent({
      eventId: "evt-repair-thread-local",
      itemId,
      completionText: "visible prefix plus local suffix",
    });

    const result = await Effect.runPromise(
      harness.repair.repairThreadAssistantMessages({
        threadId,
        sourcePolicy: "local-then-upstream",
      }),
    );
    const thread = await harness.readThread();
    const message = thread?.messages.find((entry) => entry.id === assistantMessageId);

    expect(result.counts).toMatchObject({
      totalMessages: 1,
      localAttempts: 1,
      upstreamAttempts: 0,
      repaired: 1,
      failed: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "repaired",
      source: "provider-journal",
      sourceEventId: "evt-repair-thread-local",
    });
    expect(message?.text).toBe("visible prefix plus local suffix");
  });

  it("falls back to upstream provider history when local journal has no source", async () => {
    const readThread: NonNullable<ProviderServiceShape["readThread"]> = () =>
      Effect.succeed({
        provider,
        providerInstanceId,
        snapshot: {
          threadId,
          turns: [
            {
              id: turnId,
              items: [
                {
                  id: String(itemId),
                  text: "visible prefix plus upstream suffix",
                  type: "agentMessage",
                },
              ],
            },
          ],
        },
      });
    const harness = await createHarness("repair-thread-upstream", { readThread });
    await harness.seedTerminalAssistantMessage();

    const result = await Effect.runPromise(
      harness.repair.repairThreadAssistantMessages({
        threadId,
        sourcePolicy: "local-then-upstream",
      }),
    );
    const thread = await harness.readThread();
    const message = thread?.messages.find((entry) => entry.id === assistantMessageId);

    expect(result.counts).toMatchObject({
      totalMessages: 1,
      localAttempts: 1,
      upstreamAttempts: 1,
      repaired: 1,
      sourceNotFound: 0,
      upstreamUnavailable: 0,
    });
    expect(result.results[0]).toMatchObject({
      status: "repaired",
      source: "upstream-provider",
      itemId,
    });
    expect(result.results[0]).not.toHaveProperty("sourceEventId");
    expect(message?.text).toBe("visible prefix plus upstream suffix");
  });
});
