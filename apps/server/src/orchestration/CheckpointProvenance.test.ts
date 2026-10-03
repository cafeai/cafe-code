import { describe, expect, it } from "vitest";
import { CheckpointRef, ThreadId } from "@cafecode/contracts";

import { checkpointRefForThreadTurn, legacyCheckpointRefAlias } from "../checkpointing/Utils.ts";
import { computeCheckpointRefPrunePlan } from "./Layers/CheckpointReactor.ts";

describe("checkpoint provenance cleanup", () => {
  it("never prunes source refs copied into a fork's readable history", () => {
    const source = ThreadId.make("checkpoint-source");
    const target = ThreadId.make("checkpoint-fork");
    const sourceRef = checkpointRefForThreadTurn(source, 1, 42);
    const sourceLegacyAlias = legacyCheckpointRefAlias(sourceRef);
    if (sourceLegacyAlias === null) throw new Error("Expected a generated legacy alias");
    const targetOldRef = checkpointRefForThreadTurn(target, 3, 42);
    const baselineRef = checkpointRefForThreadTurn(target, 2, 42);

    // Forks retain historical refs for reads. Cleanup admission is narrower:
    // only refs minted for this target may enter Git's delete command stream.
    const plan = computeCheckpointRefPrunePlan({
      threadId: target,
      currentTurnCount: 6,
      baseline: { checkpointTurnCount: 2, checkpointRef: baselineRef },
      checkpoints: [
        { checkpointTurnCount: 1, checkpointRef: sourceRef },
        { checkpointTurnCount: 2, checkpointRef: sourceLegacyAlias },
        { checkpointTurnCount: 3, checkpointRef: targetOldRef },
        { checkpointTurnCount: 4, checkpointRef: checkpointRefForThreadTurn(target, 4, 42) },
        { checkpointTurnCount: 5, checkpointRef: checkpointRefForThreadTurn(target, 5, 42) },
        { checkpointTurnCount: 7, checkpointRef: CheckpointRef.make("provider-diff:unowned") },
      ],
    });
    expect(plan.retainedTurnCounts).toEqual([6, 5, 4]);
    expect(plan.checkpointRefsToDelete).toEqual([targetOldRef, baselineRef]);
    expect(plan.checkpointRefsToDelete).not.toContain(sourceRef);
    expect(plan.checkpointRefsToDelete).not.toContain(sourceLegacyAlias);
    expect(plan.skippedNonHiddenCheckpointRefs).toBe(3);
  });

  it("retains the fresh association baseline during the first new turn", () => {
    const threadId = ThreadId.make("moved-chat");
    const baselineRef = checkpointRefForThreadTurn(threadId, 10, 77);
    const plan = computeCheckpointRefPrunePlan({
      threadId,
      currentTurnCount: 11,
      baseline: { checkpointTurnCount: 10, checkpointRef: baselineRef },
      checkpoints: [
        { checkpointTurnCount: 11, checkpointRef: checkpointRefForThreadTurn(threadId, 11, 77) },
      ],
    });
    expect(plan.retainedTurnCounts).toEqual([11, 10]);
    expect(plan.checkpointRefsToDelete).toEqual([]);
  });
});
