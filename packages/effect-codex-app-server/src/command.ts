/**
 * Select the existing Codex command-shell policy without resolving a different
 * executable or changing the caller's arguments. Injecting the platform keeps
 * policy qualification independent of the OS running a test.
 *
 * Node's native Windows launch path quotes structured argv, including empty
 * arguments and embedded quotes. Sending an .exe/.com through cmd.exe instead
 * can split a path under Program Files or interpret argument metacharacters.
 * Windows batch shims and bare commands retain their existing shell resolution;
 * this predicate does not claim that their arguments receive native quoting.
 * POSIX commands always retain their direct, shell-free launch path.
 *
 * Node 24.13.1 documents the Windows batch-file distinction here:
 * https://nodejs.org/download/release/v24.13.1/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows
 */
export function codexCommandUsesShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && !/\.(?:exe|com)$/i.test(command);
}
