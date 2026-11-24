import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-11-16T00:00:00.000Z";
const threadId = ThreadId.make("axiom-compaction");
const instanceId = ProviderInstanceId.make("axiom-personal");
const thread = (): OrchestrationThread => ({
  id: threadId,
  projectId: null,
  title: "Axiom compaction",
  modelSelection: { instanceId, model: "native-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId,
    status: "ready",
    providerName: "axiom",
    providerInstanceId: instanceId,
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
});
const command = () => ({
  type: "thread.compact" as const,
  commandId: CommandId.make("compact-native-axiom"),
  threadId,
  providerInstanceId: instanceId,
  createdAt: now,
});
const decide = (current = thread(), input = command()) => {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    projects: [],
    threads: [current],
    updatedAt: now,
  };
  return decideOrchestrationCommand({ command: input, readModel });
};

describe("Axiom idle compaction admission", () => {
  it("admits native compaction for the exact existing Axiom session", async () => {
    const event = await Effect.runPromise(decide());
    expect(event).toMatchObject({
      type: "thread.compaction-requested",
      payload: { threadId, providerInstanceId: instanceId },
    });
  });
  it("refuses a different instance and active native work", async () => {
    expect(
      (
        await Effect.runPromise(
          Effect.exit(
            decide(thread(), {
              ...command(),
              providerInstanceId: ProviderInstanceId.make("axiom-other"),
            }),
          ),
        )
      )._tag,
    ).toBe("Failure");
    const idle = thread();
    const running: OrchestrationThread = {
      ...idle,
      session: { ...idle.session!, status: "running", activeTurnId: TurnId.make("active-turn") },
    };
    expect((await Effect.runPromise(Effect.exit(decide(running))))._tag).toBe("Failure");
  });
});
