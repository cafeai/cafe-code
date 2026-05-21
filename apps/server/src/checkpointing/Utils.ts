import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@cafecode/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/cafe/checkpoints";
export const LEGACY_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function legacyCheckpointRefAlias(checkpointRef: string): CheckpointRef | null {
  const value = String(checkpointRef);
  if (!value.startsWith(CHECKPOINT_REFS_PREFIX)) {
    return null;
  }
  return CheckpointRef.make(
    `${LEGACY_CHECKPOINT_REFS_PREFIX}${value.slice(CHECKPOINT_REFS_PREFIX.length)}`,
  );
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
