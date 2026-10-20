import { randomUUID } from "node:crypto";
// Native filesystem boundary: preserve descriptor, no-follow and bigint identity operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// Native filesystem boundary: preserve descriptor, no-follow and bigint identity operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, open, rename, unlink } from "node:fs/promises";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { basename, dirname, join } from "node:path";

export type SaveDictationDraftResult = "saved" | "cancelled" | "failed";

export interface SaveDictationDraftInput {
  readonly text: string;
  /** The native picker is owned by Electron main and invokes this callback. */
  readonly chooseDestination: () => Promise<{
    readonly canceled: boolean;
    readonly filePath?: string;
  }>;
  /** A closed or replaced panel must lose the authority granted by its picker. */
  readonly isCurrent: () => boolean;
}

/**
 * A picker selection grants one explicit UTF-8 export. Keep the user draft
 * private until a sibling temporary file is fully flushed, then commit with
 * one rename. Never follow an existing destination symlink or reveal a picker
 * exception (which may contain a private path) to the renderer.
 */
export async function saveDictationDraft({
  text,
  chooseDestination,
  isCurrent,
}: SaveDictationDraftInput): Promise<SaveDictationDraftResult> {
  let selection: Awaited<ReturnType<typeof chooseDestination>>;
  try {
    selection = await chooseDestination();
  } catch {
    return "failed";
  }
  if (selection.canceled || !selection.filePath || !isCurrent()) return "cancelled";

  const destination = selection.filePath;
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.cafe-${randomUUID()}.tmp`,
  );
  try {
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return "failed";

    // O_EXCL and O_NOFOLLOW make the random private sibling safe against a
    // same-directory attacker even before the atomic rename takes ownership.
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The user can cancel or close the panel while a slow filesystem write is
    // in progress. Recheck authority immediately before the visible commit.
    if (!isCurrent()) return "cancelled";
    await rename(temporary, destination);
    return "saved";
  } catch {
    return "failed";
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
