// Native provider filesystem boundary: retain no-follow descriptors, bigint identity and exact namespace ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { stat } from "node:fs/promises";
// Native provider path boundary: retain host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";

/** Preserve configured cwd spelling while admitting equivalent normalization
 * and existing directory aliases. Filesystem identities are comparison keys,
 * never launch paths. Unreadable/missing distinct spellings fail closed.
 */
export async function sameForkWorkspace(
  expected: string,
  actual: string | undefined,
): Promise<boolean> {
  if (!actual) return false;
  if (path.resolve(expected) === path.resolve(actual)) return true;
  try {
    const [left, right] = await Promise.all([
      stat(expected, { bigint: true }),
      stat(actual, { bigint: true }),
    ]);
    return (
      left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
    );
  } catch {
    return false;
  }
}
