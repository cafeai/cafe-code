import {
  MAX_HIDDEN_SIDEBAR_PROJECT_KEY_LENGTH,
  MAX_HIDDEN_SIDEBAR_PROJECT_KEYS,
} from "@cafecode/contracts/settings";

/**
 * Hidden sidebar projects.
 *
 * Hiding is presentation only: a hidden project and its chats are unchanged,
 * keep running and remain searchable; the sidebar just lists them in a
 * collapsed Hidden group instead of the main Projects list. The saved list
 * holds physical project keys (`<environmentId>:<normalized cwd>`), the same
 * identity used for manual order and grouping overrides.
 */

interface HideableProject {
  readonly memberProjects: readonly { readonly physicalProjectKey: string }[];
}

/**
 * A grouped row is hidden only while every member folder is. A new folder
 * joining the group (for example a fresh worktree) brings the row back rather
 * than silently disappearing with its siblings.
 */
export function isSidebarProjectHidden(
  project: HideableProject,
  hiddenKeys: ReadonlySet<string>,
): boolean {
  return (
    project.memberProjects.length > 0 &&
    project.memberProjects.every((member) => hiddenKeys.has(member.physicalProjectKey))
  );
}

/** Splits already-sorted rows, keeping their order in both lists. */
export function partitionHiddenSidebarProjects<T extends HideableProject>(
  projects: readonly T[],
  hiddenKeys: ReadonlySet<string>,
): { readonly shown: T[]; readonly hidden: T[] } {
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const project of projects) {
    (isSidebarProjectHidden(project, hiddenKeys) ? hidden : shown).push(project);
  }
  return { shown, hidden };
}

export interface HiddenSidebarProjectPruneScope {
  /** Workspace whose complete project catalog is loaded. */
  readonly environmentId: string;
  /** Every physical project key currently in that workspace. */
  readonly knownKeys: ReadonlySet<string>;
}

/**
 * The saved list after hiding or showing one row.
 *
 * Writers prune keys for this workspace's projects that no longer exist, but
 * only when given a complete catalog (`prune`), so a still-loading or
 * disconnected workspace never loses its choices. Keys from other environments
 * are left alone. At the contract bound the oldest entries are dropped.
 */
export function nextHiddenSidebarProjectKeys(input: {
  readonly current: readonly string[];
  readonly memberKeys: readonly string[];
  readonly hidden: boolean;
  readonly prune: HiddenSidebarProjectPruneScope | null;
}): string[] {
  const members = new Set(
    input.memberKeys.filter(
      (key) => key.length > 0 && key.length <= MAX_HIDDEN_SIDEBAR_PROJECT_KEY_LENGTH,
    ),
  );
  const prefix = input.prune ? `${input.prune.environmentId}:` : null;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const key of input.current) {
    if (members.has(key) || seen.has(key)) continue;
    if (prefix !== null && key.startsWith(prefix) && !input.prune!.knownKeys.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  if (input.hidden) next.push(...members);
  return next.length > MAX_HIDDEN_SIDEBAR_PROJECT_KEYS
    ? next.slice(next.length - MAX_HIDDEN_SIDEBAR_PROJECT_KEYS)
    : next;
}
