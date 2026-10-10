import { isAbsolute } from "node:path";

export function macSourceLaunchArgs(input: {
  readonly appBundlePath: string;
  readonly entryPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly args: readonly string[];
}): readonly string[] {
  // LaunchServices does not inherit the source launcher's working directory.
  for (const path of [input.appBundlePath, input.entryPath, input.stdoutPath, input.stderrPath]) {
    if (!isAbsolute(path)) throw new Error("macOS source launch paths must be absolute.");
  }
  return [
    "-n",
    "-a",
    input.appBundlePath,
    "--stdout",
    input.stdoutPath,
    "--stderr",
    input.stderrPath,
    // Provider-backed restart commands inherit this flag. An empty value keeps
    // Electron in GUI mode when LaunchServices forwards the environment.
    "--env",
    "ELECTRON_RUN_AS_NODE",
    "--args",
    input.entryPath,
    ...input.args,
  ];
}
