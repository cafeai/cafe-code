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

export function isGeneratedHiddenCheckpointRef(checkpointRef: string): boolean {
  const value = String(checkpointRef);
  if (
    !(
      value.startsWith(`${CHECKPOINT_REFS_PREFIX}/`) ||
      value.startsWith(`${LEGACY_CHECKPOINT_REFS_PREFIX}/`)
    )
  ) {
    return false;
  }

  // Hidden checkpoint refs are the only refs Cafe owns in git. Provider-diff
  // placeholders and corrupted persisted values must never be sent into
  // `git update-ref --stdin`, because that command parses stdin as a command
  // language and the VCS layer deliberately rejects anything outside this
  // generated grammar.
  return /^refs\/(?:cafe|t3)\/checkpoints\/[A-Za-z0-9_-]+\/turn\/(?:0|[1-9][0-9]*)$/.test(value);
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

function normalizeComparablePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function isSamePath(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

export function resolveThreadWorkspaceDirectories(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly additionalWorkspaceRoots?: ReadonlyArray<string> | undefined;
  }>;
}): {
  readonly cwd: string | undefined;
  readonly additionalDirectories: ReadonlyArray<string>;
} {
  const project = input.projects.find((candidate) => candidate.id === input.thread.projectId);
  const cwd = resolveThreadWorkspaceCwd(input);
  if (!project || !cwd) {
    return { cwd, additionalDirectories: [] };
  }

  const additionalDirectories: string[] = [];
  for (const root of project.additionalWorkspaceRoots ?? []) {
    if (isSamePath(root, cwd)) {
      continue;
    }
    if (!additionalDirectories.some((existingRoot) => isSamePath(existingRoot, root))) {
      additionalDirectories.push(root);
    }
  }

  return { cwd, additionalDirectories };
}
