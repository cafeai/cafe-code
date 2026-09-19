/**
 * Bounded snapshot diffing for the read-only workspace observatory.
 *
 * The observatory only ever holds two snapshots of a file: the one currently
 * shown in a pane and the one just fetched. These helpers summarise what
 * changed between them. They describe a change in the file, never who or what
 * caused it.
 *
 * @module workspaceObservatoryDiff
 */

/** Maximum change entries retained for one file diff. */
export const WORKSPACE_OBSERVATORY_DIFF_LIMIT = 200;

export type FileLineChange =
  | { readonly kind: "added"; readonly line: number; readonly after: string }
  | { readonly kind: "removed"; readonly line: number; readonly before: string }
  | {
      readonly kind: "changed";
      readonly line: number;
      readonly before: string;
      readonly after: string;
    };

export interface FileLineDiff {
  readonly changed: boolean;
  readonly changes: readonly FileLineChange[];
  readonly truncated: boolean;
}

function pushBounded(target: FileLineChange[], value: FileLineChange): boolean {
  if (target.length >= WORKSPACE_OBSERVATORY_DIFF_LIMIT) return false;
  target.push(value);
  return true;
}

/**
 * Compute a bounded, latest-snapshot-only line summary. Common leading and
 * trailing lines are removed first so a local insertion does not make the
 * remainder of a file look rewritten.
 */
export function diffFileLines(before: string, after: string): FileLineDiff {
  if (before === after) return { changed: false, changes: [], truncated: false };
  const previous = before.split("\n");
  const current = after.split("\n");

  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < current.length &&
    previous[prefix] === current[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < current.length - prefix &&
    previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const previousMiddle = previous.slice(prefix, previous.length - suffix);
  const currentMiddle = current.slice(prefix, current.length - suffix);
  const changes: FileLineChange[] = [];
  let truncated = false;

  const shared = Math.min(previousMiddle.length, currentMiddle.length);
  for (let index = 0; index < shared; index += 1) {
    if (previousMiddle[index] === currentMiddle[index]) continue;
    if (
      !pushBounded(changes, {
        kind: "changed",
        line: prefix + index + 1,
        before: previousMiddle[index]!,
        after: currentMiddle[index]!,
      })
    ) {
      truncated = true;
      break;
    }
  }
  if (!truncated) {
    for (let index = shared; index < previousMiddle.length; index += 1) {
      if (
        !pushBounded(changes, {
          kind: "removed",
          line: prefix + index + 1,
          before: previousMiddle[index]!,
        })
      ) {
        truncated = true;
        break;
      }
    }
  }
  if (!truncated) {
    for (let index = shared; index < currentMiddle.length; index += 1) {
      if (
        !pushBounded(changes, {
          kind: "added",
          line: prefix + index + 1,
          after: currentMiddle[index]!,
        })
      ) {
        truncated = true;
        break;
      }
    }
  }

  return { changed: true, changes, truncated };
}
