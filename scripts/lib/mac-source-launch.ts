import { isAbsolute, join, resolve } from "node:path";

/** Match desktop lexical home expansion before LaunchServices loses cwd. */
export function resolveMacSourceConfiguredHome(
  raw: string | undefined,
  homeDirectory: string,
): string {
  const configured = raw?.trim() || join(homeDirectory, ".cafe-code");
  return resolve(
    configured === "~"
      ? homeDirectory
      : configured.startsWith("~/") || configured.startsWith("~\\")
        ? join(homeDirectory, configured.slice(2))
        : configured,
  );
}

export function macSourceLaunchArgs(input: {
  readonly appBundlePath: string;
  readonly entryPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly configuredBaseDir: string;
  readonly args: readonly string[];
}): readonly string[] {
  // LaunchServices does not inherit the source launcher's working directory.
  for (const path of [
    input.appBundlePath,
    input.entryPath,
    input.stdoutPath,
    input.stderrPath,
    input.configuredBaseDir,
  ]) {
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
    // LaunchServices forwards only an explicit, non-secret selection. Do not
    // depend on its inherited login environment to preserve a custom Cafe home
    // or forward the entire launching shell's provider credentials.
    "--env",
    `CAFE_CODE_HOME=${input.configuredBaseDir}`,
    "--env",
    "CAFE_CODE_DATA_PROFILE=debug",
    "--args",
    input.entryPath,
    ...input.args,
  ];
}
