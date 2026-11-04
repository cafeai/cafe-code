// This synchronous command-construction boundary must choose the native argv
// policy before a caller admits its process. It performs only the bounded
// Windows executable search below, never provider/profile or credential IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { statSync } from "node:fs";
// Windows spelling is required even in foreign-host policy tests; the generic
// Effect Path service would describe the test host rather than the child.
// @effect-diagnostics-next-line nodeBuiltinImport:off
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

// The limits bound both parser input and native filesystem work before any
// lookup. Refusing the whole search preserves order; truncating it could select
// a different executable from a later PATH/PATHEXT entry. Explicit supported
// executable paths do not need a PATH search and keep their original behavior.
const MAX_WINDOWS_SEARCH_VALUE_LENGTH = 32_767;
const MAX_WINDOWS_SEARCH_CANDIDATES = 4096;
const unsupportedWindowsCommand = (): never => {
  throw new TypeError("Unsupported or unavailable Windows Codex command.");
};

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

function searchEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = environmentValue(environment, name) ?? fallback;
  if (value.length > MAX_WINDOWS_SEARCH_VALUE_LENGTH || /[\u0000\r\n]/u.test(value)) {
    return unsupportedWindowsCommand();
  }
  return value;
}

function windowsPathDirectories(value: string): Array<string> {
  const directories: Array<string> = [];
  let start = 0;
  while (start < value.length) {
    if (value[start] === ";") {
      start += 1;
      continue;
    }
    if (value[start] === '"') {
      // A semicolon inside one quoted directory is a filename character. Do
      // not split it before finding the matching quote, and never reinterpret
      // an unmatched quote or trailing command text through a fallback shell.
      const end = value.indexOf('"', start + 1);
      if (end < 0 || (end + 1 < value.length && value[end + 1] !== ";")) {
        return unsupportedWindowsCommand();
      }
      directories.push(value.slice(start + 1, end));
      start = end + 2;
      continue;
    }
    const separator = value.indexOf(";", start);
    const end = separator < 0 ? value.length : separator;
    const directory = value.slice(start, end);
    if (directory.includes('"')) return unsupportedWindowsCommand();
    directories.push(directory);
    start = end + 1;
  }
  return directories;
}

function resolveWindowsCommand(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = searchEnvironmentValue(environment, "PATHEXT", ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  if (extensions.some((extension) => !/^\.[A-Za-z0-9]+$/u.test(extension))) {
    return unsupportedWindowsCommand();
  }
  const directories = /[\\/]/u.test(command)
    ? [cwd]
    : [
        ...(environmentValue(environment, "NODEFAULTCURRENTDIRECTORYINEXEPATH") === undefined
          ? [cwd]
          : []),
        ...windowsPathDirectories(searchEnvironmentValue(environment, "PATH", "")),
      ];
  if (directories.length * (extensions.length + 1) > MAX_WINDOWS_SEARCH_CANDIDATES) {
    return unsupportedWindowsCommand();
  }
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
  if (command.length === 0 || command.length > MAX_WINDOWS_SEARCH_VALUE_LENGTH) {
    return unsupportedWindowsCommand();
  }
  // Unsupported explicit extensions cannot become a different executable by
  // appending PATHEXT, nor a shell program merely because resolution failed.
  const extension = path.extname(command);
  if (extension && !/^\.(?:cmd|bat)$/iu.test(extension)) {
    return unsupportedWindowsCommand();
  }
  // A drive-relative spelling (including the empty-tail C:) is an explicit
  // path, not a bare command name. Its per-drive working-directory semantics
  // are not supported by this extensionless resolver; never reinterpret it
  // through PATH and select an unrelated executable. Explicit native/batch
  // extensions retain their existing direct/forwarding behavior.
  if (!extension && /^[A-Za-z]:(?:[^\\/]|$)/u.test(command)) {
    return unsupportedWindowsCommand();
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
  // Even a missing provider must never hand raw argv to cmd.exe: shell
  // operators can execute a second command after the first command fails.
  // Keep this error opaque; configured paths, argv and environment are private.
  return unsupportedWindowsCommand();
}
