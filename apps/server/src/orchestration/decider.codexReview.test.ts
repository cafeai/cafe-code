import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CodexReviewTarget,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadTurnStartCommand,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-10-05T00:00:00.000Z";
const threadId = ThreadId.make("native-review-chat");
const selection = {
  instanceId: ProviderInstanceId.make("codex-personal"),
  model: "gpt-6.1-sol",
  options: [],
};
function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: null,
    title: "Review",
    modelSelection: selection,
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
    session: null,
  };
}
function command(
  target: CodexReviewTarget = { type: "uncommittedChanges" },
): typeof ThreadTurnStartCommand.Type {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("review-command"),
    threadId,
    message: {
      messageId: MessageId.make("review-message"),
      role: "user",
      text: "Native review",
      attachments: [],
    },
    codexReview: target,
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: now,
  };
}
async function decide(input = command(), thread = makeThread()) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 1,
    projects: [],
    threads: [thread],
    updatedAt: now,
  };
  const result = await Effect.runPromise(decideOrchestrationCommand({ command: input, readModel }));
  return Array.isArray(result) ? result : [result];
}
describe("native review durable admission", () => {
  it.each<CodexReviewTarget>([
    { type: "uncommittedChanges" },
    { type: "baseBranch", branch: "origin/main" },
    { type: "commit", sha: "abcdef1234567" },
    { type: "custom", instructions: "Inspect concurrency" },
  ])("persists an explicit $type operation without parsing its display text", async (target) => {
    const events = await decide(command(target));
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[1]?.payload).toMatchObject({ codexReview: target, modelSelection: selection });
  });
  it.each(["starting", "running"] as const)(
    "rejects %s rather than silently steering",
    async (status) => {
      const thread: OrchestrationThread = {
        ...makeThread(),
        session: {
          threadId,
          status,
          providerName: "codex",
          providerInstanceId: selection.instanceId,
          runtimeMode: "approval-required",
          activeTurnId: status === "running" ? TurnId.make("active") : null,
          lastError: null,
          updatedAt: now,
        },
      };
      await expect(decide(command(), thread)).rejects.toThrow(
        "Native review requires an idle chat",
      );
    },
  );
  it("rejects stale account and permission changes rather than choosing who pays", async () => {
    await expect(
      decide({
        ...command(),
        modelSelection: { ...selection, instanceId: ProviderInstanceId.make("codex-other") },
      }),
    ).rejects.toThrow("Native review requires");
    await expect(decide({ ...command(), runtimeMode: "full-access" })).rejects.toThrow(
      "Native review requires",
    );
  });
  it("does not recognize native review authority in ordinary model prose", async () => {
    const { codexReview: _review, ...ordinary } = command();
    const events = await decide(ordinary);
    expect(events[1]?.payload).not.toHaveProperty("codexReview");
  });
});
