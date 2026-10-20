// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir } from "node:fs/promises";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { promisify } from "node:util";

/** Runs only on a fresh CI-owned D-Bus session. Keep the native secret service
 * and its random login password private to this extracted artifact fixture. */
export async function withLinuxArtifactKeyring(
  root: string,
  action: (environment: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS?.startsWith("unix:")) {
    throw new Error("Linux artifact keyring requires its own native D-Bus session.");
  }
  const home = join(root, "keyring-home");
  const control = join(home, "control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CURRENT_DESKTOP: "GNOME",
    GNOME_KEYRING_CONTROL: control,
  };
  const daemon = spawn(
    "gnome-keyring-daemon",
    ["--foreground", "--unlock", "--components=secrets", `--control-directory=${control}`],
    { env: environment, stdio: ["pipe", "ignore", "ignore"] },
  );
  const exited = new Promise<void>((resolveExit, reject) => {
    daemon.once("error", reject);
    daemon.once("exit", () => resolveExit());
  });
  // Observe early rejection even if native readiness is still pending.
  void exited.catch(() => undefined);
  daemon.stdin.on("error", () => undefined);
  daemon.stdin.end(randomBytes(32).toString("hex"));
  const readinessController = new AbortController();
  const readiness = promisify(execFile)("gdbus", ["wait", "--session", "org.freedesktop.secrets"], {
    env: environment,
    timeout: 10_000,
    maxBuffer: 1_024,
    signal: readinessController.signal,
  });
  try {
    await Promise.race([
      readiness,
      exited.then(() => {
        throw new Error("Private Linux keyring exited before readiness.");
      }),
    ]);
    await action(environment);
  } finally {
    readinessController.abort();
    await readiness.catch(() => undefined);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
    // This native wait owns an external child/stream lifetime; a virtual
    // Effect clock must not replace its existing deadline or cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    const timeout = setTimeout(() => daemon.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
}
