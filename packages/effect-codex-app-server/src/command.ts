import { statSync } from "node:fs";
import { win32 as path } from "node:path";
import { ChildProcess } from "effect/unstable/process";

/**
 * Select the existing Codex command-shell policy without resolving a different
 * executable or changing the caller's arguments. Injecting the platform keeps
 * policy qualification independent of the OS running a test.
 *
 * Node's native Windows launch path quotes structured argv, including empty
 * arguments and embedded quotes. Sending an .exe/.com through cmd.exe instead
 * can split a path under Program Files or interpret argument metacharacters.
 * Batch commands require makeCodexCommand's additional forwarding escaping.
 * This predicate classifies a spelling; extensionless Windows names are resolved
 * by the command builder before selecting native or batch argument handling.
 * POSIX commands always retain their direct, shell-free launch path.
 *
 * Node 24.13.1 documents the Windows batch-file distinction here:
 * https://nodejs.org/download/release/v24.13.1/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows
 */
export function codexCommandUsesShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && !/\.(?:exe|com)$/i.test(command);
}

const shellCharacters = /([()\][%!^"`<>&|;, *?])/gu;
const escapeShellCharacters = (value: string) => value.replace(shellCharacters, "^$1");

function quoteBatchArgument(value: string): string {
  // Account for native Windows argv quoting, then both cmd.exe's initial
  // parse and the batch shim's %* forwarding parse. Escaping only once keeps
  // TOML quotes but still lets the forwarded command interpret & and %.
  // Scan once instead of backtracking over a long run of backslashes.
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += `${"\\".repeat(backslashes * 2)}"`;
  return escapeShellCharacters(escapeShellCharacters(quoted));
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  // Node forwards the first case-insensitive key in lexicographic order on Windows.
  const key = Object.keys(environment)
    .toSorted()
    .find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : environment[key];
}

function resolveWindowsCommand(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension));
  const directories = /[\\/]/u.test(command)
    ? [cwd]
    : [
        ...(environmentValue(environment, "NODEFAULTCURRENTDIRECTORYINEXEPATH") === undefined
          ? [cwd]
          : []),
        ...(environmentValue(environment, "PATH") ?? "")
          .split(";")
          .filter(Boolean)
          .map((directory) => directory.replace(/^"(.*)"$/u, "$1")),
      ];
  for (const directory of directories) {
    const base = path.resolve(cwd, directory, command);
    for (const extension of ["", ...extensions]) {
      const candidate = `${base}${extension}`;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Match executable search by continuing past unavailable candidates.
      }
    }
  }
  return undefined;
}

/** Build all Cafe-owned Codex subprocesses through the same Windows argv boundary. */
export function makeCodexCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = {},
  platform: NodeJS.Platform = process.platform,
): ChildProcess.StandardCommand {
  if (!codexCommandUsesShell(command, platform)) {
    return ChildProcess.make(command, [...args], { ...options, shell: false });
  }
  if (
    [command, ...args].some(
      (value) => value.includes("\u0000") || value.includes("\r") || value.includes("\n"),
    )
  ) {
    throw new TypeError("Invalid Windows Codex command argument.");
  }
  const environment = options.extendEnv
    ? { ...process.env, ...options.env }
    : (options.env ?? process.env);
  // Resolve extensionless commands using this child's cwd/PATH/PATHEXT, so
  // `codex` can select a batch shim or a native executable without applying
  // batch escaping to a directly launched .exe. Explicit paths remain authoritative.
  const resolved = /\.(?:cmd|bat)$/iu.test(command)
    ? command
    : resolveWindowsCommand(command, options.cwd ?? process.cwd(), environment);
  if (resolved !== undefined && !codexCommandUsesShell(resolved, platform)) {
    return ChildProcess.make(resolved, [...args], { ...options, shell: false });
  }
  if (resolved !== undefined && /\.(?:cmd|bat)$/iu.test(resolved)) {
    return ChildProcess.make(escapeShellCharacters(resolved), args.map(quoteBatchArgument), {
      ...options,
      shell: true,
    });
  }
  // Keep the existing not-found/unsupported-command behavior. Do not guess a
  // different executable or reinterpret a custom command as a batch shim.
  return ChildProcess.make(command, [...args], { ...options, shell: true });
}
