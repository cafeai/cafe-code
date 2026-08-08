#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsSystemExecutable } from "./windows-system-path.ts";

interface FallbackArgs {
  readonly mode: "recovery" | "update-failed" | "shutdown-failed";
  readonly projectDirectory: string;
  readonly claudePath: string;
  readonly codexPath: string;
  readonly logPath: string | null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCommand(command: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
  for (const directory of pathValue.split(NodePath.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = NodePath.join(directory, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function parseFallbackArgs(args: ReadonlyArray<string>): FallbackArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !value ||
      !["--project-dir", "--claude", "--codex", "--mode", "--log"].includes(flag)
    ) {
      throw new Error(
        "Fallback requires --project-dir, --claude, and --codex structured arguments.",
      );
    }
    values.set(flag, value);
  }
  const projectDirectory = values.get("--project-dir");
  const claudePath = values.get("--claude");
  const codexPath = values.get("--codex");
  const modeValue = values.get("--mode") ?? "recovery";
  if (
    modeValue !== "recovery" &&
    modeValue !== "update-failed" &&
    modeValue !== "shutdown-failed"
  ) {
    throw new Error("Fallback mode is invalid.");
  }
  const logPath = values.get("--log") ?? null;
  if (!projectDirectory || !claudePath || !codexPath) {
    throw new Error("Fallback arguments are incomplete.");
  }
  if (modeValue !== "recovery" && !logPath) {
    throw new Error("Failure notice requires --log.");
  }
  return { mode: modeValue, projectDirectory, claudePath, codexPath, logPath };
}

async function spawnInteractive(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function windowsFallback(input: FallbackArgs): Promise<void> {
  const powershell = resolveWindowsSystemExecutable(
    String.raw`WindowsPowerShell\v1.0\powershell.exe`,
  );
  if (!isExecutable(powershell)) throw new Error("Trusted Windows PowerShell is unavailable.");
  await spawnInteractive(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      NodePath.join(
        NodePath.dirname(fileURLToPath(import.meta.url)),
        "provider-update-fallback.ps1",
      ),
      "-ProjectDirectory",
      input.projectDirectory,
      "-ClaudePath",
      input.claudePath,
      "-CodexPath",
      input.codexPath,
      "-Mode",
      input.mode,
      ...(input.logPath ? ["-LogPath", input.logPath] : []),
    ],
    input.projectDirectory,
  );
}

async function macFallback(input: FallbackArgs): Promise<void> {
  const osascript = pathCommand("osascript");
  if (!osascript) throw new Error("Cafe Code relaunch failed. Open Claude Code or Codex manually.");
  if (input.mode !== "recovery") {
    const action =
      input.mode === "shutdown-failed"
        ? "Cafe Code could not prove that every existing process stopped, so it did not update providers or launch a second instance."
        : "The provider CLI update failed, but Cafe Code restarted successfully.";
    const result = spawnSync(
      osascript,
      [
        "-e",
        "on run argv",
        "-e",
        `display alert "Cafe Code provider update" message (${JSON.stringify(`${action} Details: `)} & item 1 of argv) as warning`,
        "-e",
        "end run",
        input.logPath ?? "",
      ],
      { cwd: input.projectDirectory, shell: false, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return;
  }
  const recoveryDetail = input.logPath
    ? ` The provider update also failed. Details: ${input.logPath}`
    : "";
  const result = spawnSync(
    osascript,
    [
      "-e",
      "on run argv",
      "-e",
      'button returned of (display dialog ("Cafe Code could not relaunch. Open a provider in the saved project?" & item 1 of argv) buttons {"Cancel", "Codex", "Claude Code"} default button "Claude Code")',
      "-e",
      "end run",
      recoveryDetail,
    ],
    { cwd: input.projectDirectory, shell: false, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || typeof result.stdout !== "string") return;
  const selected = result.stdout.trim();
  if (selected !== "Claude Code" && selected !== "Codex") return;
  const executable = selected === "Claude Code" ? input.claudePath : input.codexPath;
  const shellCommand = `cd -- '${input.projectDirectory.replaceAll("'", "'\\''")}' && exec '${executable.replaceAll("'", "'\\''")}'`;
  await spawnInteractive(
    osascript,
    [
      "-e",
      "on run argv",
      "-e",
      'tell application "Terminal" to do script (item 1 of argv)',
      "-e",
      "end run",
      shellCommand,
    ],
    input.projectDirectory,
  );
}

async function linuxFallback(input: FallbackArgs): Promise<void> {
  const zenity = pathCommand("zenity");
  const kdialog = pathCommand("kdialog");
  if (!zenity && !kdialog) {
    throw new Error(
      `Cafe Code relaunch failed. Open Claude Code or Codex manually from ${input.projectDirectory}.`,
    );
  }
  if (input.mode !== "recovery") {
    const message =
      input.mode === "shutdown-failed"
        ? `Cafe Code could not prove that every existing process stopped, so it did not update providers or launch a second instance. Details: ${String(input.logPath)}`
        : `The provider CLI update failed, but Cafe Code restarted successfully. Details: ${String(input.logPath)}`;
    const notice = zenity
      ? spawnSync(zenity, ["--warning", "--title=Cafe Code provider update", `--text=${message}`], {
          cwd: input.projectDirectory,
          shell: false,
          encoding: "utf8",
        })
      : spawnSync(kdialog as string, ["--title", "Cafe Code provider update", "--sorry", message], {
          cwd: input.projectDirectory,
          shell: false,
          encoding: "utf8",
        });
    if (notice.error) throw notice.error;
    return;
  }
  const recoveryText = input.logPath
    ? `Cafe Code could not relaunch. The provider update also failed; details: ${input.logPath}. Open a provider in the saved project?`
    : "Cafe Code could not relaunch. Open a provider in the saved project?";
  const result = zenity
    ? spawnSync(
        zenity,
        [
          "--list",
          "--title=Cafe Code recovery",
          `--text=${recoveryText}`,
          "--column=Provider",
          "Claude Code",
          "Codex",
        ],
        { cwd: input.projectDirectory, shell: false, encoding: "utf8" },
      )
    : spawnSync(
        kdialog as string,
        [
          "--title",
          "Cafe Code recovery",
          "--menu",
          recoveryText,
          "claude",
          "Claude Code",
          "codex",
          "Codex",
        ],
        { cwd: input.projectDirectory, shell: false, encoding: "utf8" },
      );
  if (result.error) throw result.error;
  if (result.status !== 0 || typeof result.stdout !== "string") return;
  const selection = result.stdout.trim().toLowerCase();
  if (selection !== "claude code" && selection !== "claude" && selection !== "codex") return;
  const executable = selection === "codex" ? input.codexPath : input.claudePath;
  const terminals: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["gnome-terminal", ["--working-directory", input.projectDirectory, "--", executable]],
    ["konsole", ["--workdir", input.projectDirectory, "-e", executable]],
    ["kitty", ["--directory", input.projectDirectory, executable]],
    ["xterm", ["-e", executable]],
  ];
  for (const [name, args] of terminals) {
    const terminal = pathCommand(name);
    if (terminal) {
      await spawnInteractive(terminal, args, input.projectDirectory);
      return;
    }
  }
  throw new Error(`Cafe Code relaunch failed. Run ${executable} from ${input.projectDirectory}.`);
}

async function main(): Promise<void> {
  const args = parseFallbackArgs(process.argv.slice(2));
  const resolvedProjectDirectory = realpathSync.native(args.projectDirectory);
  const resolvedLogPath = args.logPath ? realpathSync.native(args.logPath) : null;
  const input = {
    ...args,
    projectDirectory: resolvedProjectDirectory,
    logPath: resolvedLogPath,
  };
  if (process.platform === "win32") await windowsFallback(input);
  else if (process.platform === "darwin") await macFallback(input);
  else await linuxFallback(input);
}

function isExecutedAsMainModule(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  try {
    return realpathSync.native(entryPoint) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedAsMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
