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

/** A durable association event creates a fresh, replay-stable Git ref namespace. */
export function checkpointRefForThreadTurn(
  threadId: ThreadId,
  turnCount: number,
  associationSequence?: number,
): CheckpointRef {
  // A distinct path production, not a delimiter inside an arbitrary ThreadId:
  // a hostile legacy id such as "victim:association:42" must not collide with
  // another conversation's association epoch after base64 encoding.
  const association =
    associationSequence === undefined ? "" : `association/${associationSequence}/`;
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/${association}turn/${turnCount}`,
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
  return /^refs\/(?:cafe|t3)\/checkpoints\/[A-Za-z0-9_-]+\/(?:association\/[1-9][0-9]*\/)?turn\/(?:0|[1-9][0-9]*)$/.test(
    value,
  );
}

/** Copied readable checkpoint history never grants cleanup rights over its source. */
export function isThreadOwnedHiddenCheckpointRef(
  threadId: ThreadId,
  checkpointRef: string,
): boolean {
  if (!isGeneratedHiddenCheckpointRef(checkpointRef)) return false;
  const segment = `${Encoding.encodeBase64Url(threadId)}/`;
  return (
    checkpointRef.startsWith(`${CHECKPOINT_REFS_PREFIX}/${segment}`) ||
    checkpointRef.startsWith(`${LEGACY_CHECKPOINT_REFS_PREFIX}/${segment}`)
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId | null;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  // A detached chat must never inherit its former project's worktree even if
  // a legacy/corrupted projection still carries that metadata.
  if (input.thread.projectId === null) return undefined;
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
    readonly projectId: ProjectId | null;
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
