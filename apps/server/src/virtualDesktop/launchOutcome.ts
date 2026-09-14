/** A direct launcher may exit after forking or forwarding to an existing
 * profile. Report that evidence without claiming its descendants failed. */
export function launchOutcome(
  process: Record<string, unknown>,
  terminal: boolean,
  windows: readonly unknown[],
) {
  if (windows.length)
    return {
      opened: !terminal,
      outcome: terminal ? "terminal_opened" : "window_appeared",
      windows,
      ...(terminal
        ? {
            message:
              "The terminal opened. The command's application window is not verified; inspect before retrying.",
          }
        : {}),
    };
  return {
    opened: false,
    outcome:
      process.state === "exited"
        ? "launcher_exited"
        : process.state === "running"
          ? "running_without_window"
          : "unverified",
    ...(typeof process.exitCode === "number" ? { exitCode: process.exitCode } : {}),
    ...(typeof process.signal === "number" ? { signal: process.signal } : {}),
    message:
      process.state === "exited"
        ? "The launcher exited without a new window here. It may have forked or forwarded to an existing profile. Inspect before retrying."
        : "No new window appeared before the deadline. The app may still be starting or using an existing profile. Inspect before retrying.",
  };
}
