import { SUBAGENT_ACTIVITY_DETAIL_MAX_BYTES } from "@cafecode/contracts";

/**
 * Public operation summaries are deliberately not a shell pretty-printer. Only
 * a small literal grammar and known harmless argument positions are displayed.
 * Unknown arguments, search text, inline programs and shell composition remain
 * hidden. This code never executes, resolves, stats or opens provider input.
 */
const MAX_SOURCE_CHARS = 8_192;
const MAX_TOKENS = 128;
const unsafeText = /[\p{Cc}\p{Cs}\p{Bidi_Control}\u2028\u2029]/u;
const credentialText =
  /(?:authorization|bearer|password|passwd|credential|secret|api[-_]?key|private[-_ ]?key|token|cookie|sk-[a-z0-9_-]{8,}|npm_[a-z0-9]{8,}|gh[pousr]_[a-z0-9]{8,}|(?:^|[/\\])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:$|[/\\]))/i;

/** Bound only the finished summary, preserving complete Unicode scalars. */
function boundedDetail(value: string): string | undefined {
  const text = value.trim();
  if (!text || unsafeText.test(text)) return undefined;
  let result = "";
  let bytes = 0;
  for (const scalar of text) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > SUBAGENT_ACTIVITY_DETAIL_MAX_BYTES - 3) return `${result}…`;
    result += scalar;
    bytes += size;
  }
  return result;
}

/**
 * Paths come from typed native file fields or known path operand positions,
 * never a generic tool payload. Hide known credential stores and URL-shaped
 * values. A path is display text, not authority to open a local file.
 */
export function subagentFileDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SOURCE_CHARS) return undefined;
  if (
    unsafeText.test(value) ||
    credentialText.test(value) ||
    /[?=#]|:\/\/|[\x60$]/u.test(value) ||
    (value.includes(":") && !/^[A-Za-z]:[/\\][^:]*$/u.test(value)) ||
    /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|\.npmrc|\.netrc|auth\.json|credentials\.json)(?:[/\\]|$)/i.test(
      value,
    )
  )
    return undefined;
  return boundedDetail(value);
}

/** Keep only a few typed paths while reporting that more were present. */
export function subagentFilesDetail(values: ReadonlyArray<unknown>): string | undefined {
  const paths = values.slice(0, 4).flatMap((value) => {
    const path = subagentFileDetail(value);
    return path === undefined ? [] : [path];
  });
  if (paths.length === 0) return undefined;
  return boundedDetail(`${paths.join(", ")}${values.length > 4 ? " …" : ""}`);
}

/**
 * Tokenize literal words only. Even inside quotes, expansions and compound
 * syntax are refused instead of guessed. Escaped whitespace/quotes are enough
 * for ordinary file names; no shell-specific escape/program interpretation.
 */
function literalWords(source: string): string[] | undefined {
  if (!source || source.length > MAX_SOURCE_CHARS || unsafeText.test(source)) return undefined;
  if (/[\x60$;&|<>#]/u.test(source)) return undefined;
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\" && quote !== "'") {
      const next = source[++index];
      if (next === undefined || !/[\\'" ]/u.test(next)) return undefined;
      word += next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " ") {
      if (started) {
        words.push(word);
        if (words.length > MAX_TOKENS) return undefined;
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words.length <= MAX_TOKENS ? words : undefined;
}

function shownWord(word: string): string {
  return word.includes(" ") ? JSON.stringify(word) : word;
}

function fileOperand(word: string): string | undefined {
  // Command arguments are less trustworthy than typed path fields. Require
  // recognizable path syntax, not arbitrary bare text from a command body.
  if (!/[/\\.]|^~[/\\]/u.test(word) || word.startsWith("-")) return undefined;
  return subagentFileDetail(word);
}

// Flags are scoped to their actual executable/subcommand. Identical spellings
// have different arity (notably rg -S versus Git's secret-bearing pickaxe -S).
const flagsByCommand: Readonly<Record<string, ReadonlyArray<string>>> = {
  "git status": ["--short", "--porcelain", "--branch", "-s"],
  "git diff": ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--check"],
  "git log": ["--oneline", "--stat", "--name-only", "--name-status", "--all"],
  "git show": ["--stat", "--name-only", "--name-status", "--oneline"],
  "git rev-parse": ["--show-toplevel", "--verify"],
  "git branch": ["--list", "-a", "-r", "--show-current"],
  "git ls-files": ["--cached", "--modified", "--others"],
  "git check-ignore": [],
  yarn: ["--force", "--check", "--run", "--silent", "--immutable"],
  rg: [
    "-n",
    "-l",
    "-S",
    "-i",
    "-F",
    "-w",
    "--hidden",
    "--line-number",
    "--ignore-case",
    "--fixed-strings",
    "--no-heading",
    "--count",
  ],
  grep: [
    "-n",
    "-l",
    "-i",
    "-F",
    "-w",
    "-r",
    "-R",
    "--line-number",
    "--ignore-case",
    "--fixed-strings",
    "--count",
  ],
  cat: ["-n", "-b", "-s", "-A", "--number"],
  head: ["-q", "-v"],
  tail: ["-q", "-v", "-f"],
  wc: ["-c", "-m", "-l", "-w"],
  stat: [],
  ls: ["-a", "-l", "-la", "-al", "-lh", "-alh", "-d"],
  node: ["--check"],
  sed: [],
};
const gitCommands = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "branch",
  "ls-files",
  "check-ignore",
]);
const yarnCommands = new Set([
  "test",
  "test:browser",
  "lint",
  "fmt",
  "typecheck",
  "build",
  "build:desktop",
  "install",
]);

function complexCommandFallback(source: string): string | undefined {
  // Only a recognized executable at the literal start may survive a refused
  // parse. Never search arbitrary code for something that resembles a command.
  const match =
    /^ *(?:\/[a-zA-Z0-9._/-]*\/)?(git|corepack|yarn|rg|grep|sed|cat|head|tail|wc|stat|ls|node|sh|bash|zsh|curl)(?= |$)/u.exec(
      source,
    );
  const executable = match?.[1];
  return executable === undefined
    ? undefined
    : `${executable} [${["sh", "bash", "zsh"].includes(executable) ? "script" : "arguments"} hidden]`;
}

/** A truthful generic label may reveal the known executable, never its source. */
export function subagentCommandDetail(value: unknown, depth = 0): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SOURCE_CHARS) return undefined;
  const tokens = literalWords(value);
  if (!tokens) return complexCommandFallback(value);
  if (tokens.length === 0) return undefined;
  // All assignment values are private, regardless of whether their names look
  // sensitive. Do not infer that innocently named variables contain no secrets.
  while (tokens[0] && /^[A-Za-z_][A-Za-z_0-9]*=/u.test(tokens[0])) tokens.shift();
  if (tokens[0] === "env") {
    tokens.shift();
    while (tokens[0] && /^[A-Za-z_][A-Za-z_0-9]*=/u.test(tokens[0])) tokens.shift();
  }
  const executable = tokens.shift()?.split(/[/\\]/u).at(-1);
  if (
    !executable ||
    !/^[a-z][a-z0-9.-]{0,40}$/u.test(executable) ||
    credentialText.test(executable)
  )
    return undefined;
  if (["sh", "bash", "zsh"].includes(executable)) {
    if (depth === 0 && tokens.length === 2 && (tokens[0] === "-c" || tokens[0] === "-lc")) {
      return subagentCommandDetail(tokens[1], 1) ?? `${executable} [script hidden]`;
    }
    return `${executable} [script hidden]`;
  }
  const fallback = `${executable} [arguments hidden]`;
  const shown = [executable];
  let flagKey = executable;
  let mode: "files" | "git" | "yarn" | "search" | "sed";
  if (executable === "corepack") {
    if (tokens.shift() !== "yarn") return fallback;
    shown.push("yarn");
    flagKey = "yarn";
    mode = "yarn";
  } else if (executable === "yarn") mode = "yarn";
  else if (executable === "git") mode = "git";
  else if (executable === "rg" || executable === "grep") mode = "search";
  else if (executable === "sed") mode = "sed";
  else if (["cat", "head", "tail", "wc", "stat", "ls", "node"].includes(executable)) mode = "files";
  else return fallback;

  if (mode === "git") {
    const command = tokens.shift();
    if (!command || !gitCommands.has(command)) return fallback;
    shown.push(command);
    flagKey = `git ${command}`;
  }
  if (mode === "yarn") {
    if (tokens[0] === "workspace") {
      tokens.shift();
      const workspace = tokens.shift();
      if (
        !workspace ||
        !/^@?[a-z][a-z0-9/._-]{0,100}$/u.test(workspace) ||
        credentialText.test(workspace)
      )
        return fallback;
      shown.push("workspace", workspace);
    }
    const command = tokens.shift();
    if (!command || !yarnCommands.has(command)) return fallback;
    shown.push(command);
  }
  if (mode === "sed") {
    if (tokens.shift() !== "-n") return fallback;
    const range = tokens.shift();
    if (!range || !/^\d{1,8}(?:,\d{1,8})?p$/u.test(range)) return fallback;
    shown.push("-n", range);
  }
  let searchPattern = mode === "search";
  let optionsEnded = false;
  let nodeScriptSeen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (nodeScriptSeen) {
      shown.push("[arguments hidden]");
      break;
    } else if (token === "--" && !optionsEnded) {
      optionsEnded = true;
      shown.push(token);
    } else if (mode === "search" && !optionsEnded && executable === "rg" && token === "--files") {
      searchPattern = false;
      shown.push(token);
    } else if (
      mode === "search" &&
      !optionsEnded &&
      (["-e", "--regexp"].includes(token) ||
        (executable === "rg" && ["-g", "--glob"].includes(token)))
    ) {
      if (tokens[++index] === undefined) return fallback;
      shown.push(token, "[pattern hidden]");
      if (token === "-e" || token === "--regexp") searchPattern = false;
    } else if (
      !optionsEnded &&
      ["head", "tail"].includes(executable) &&
      (token === "-n" || token === "-c")
    ) {
      const count = tokens[++index];
      if (!count || !/^\d{1,8}$/u.test(count)) return fallback;
      shown.push(token, count);
    } else if (
      !optionsEnded &&
      ((flagsByCommand[flagKey] ?? []).includes(token) ||
        (["head", "tail"].includes(executable) && /^-\d{1,8}$/u.test(token)) ||
        (mode === "yarn" && /^--(?:maxWorkers|concurrency)=\d{1,3}$/u.test(token)))
    ) {
      shown.push(token);
    } else if (!optionsEnded && token.startsWith("-")) {
      // Unknown options may consume secrets (including their next word).
      // Do not continue parsing with guessed argument positions.
      return fallback;
    } else if (searchPattern) {
      shown.push("[pattern hidden]");
      searchPattern = false;
    } else if (mode === "git" && /^(?:HEAD(?:~\d{1,4})?|[a-f0-9]{7,40})$/u.test(token)) {
      shown.push(token);
    } else {
      const path = flagKey === "git branch" ? undefined : fileOperand(token);
      shown.push(path === undefined ? "[argument hidden]" : shownWord(path));
      if (executable === "node") nodeScriptSeen = true;
    }
  }
  return boundedDetail(shown.join(" "));
}
