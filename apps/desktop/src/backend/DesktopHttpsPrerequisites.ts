// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

export const WINDOWS_OPENSSL_COMMAND_CANDIDATES = ["openssl.exe", "openssl"] as const;

export interface DesktopHttpsSupportOptions {
  readonly platform?: NodeJS.Platform;
  readonly commandIsUsable?: (command: string) => boolean;
}

function defaultCommandIsUsable(command: string): boolean {
  const result = spawnSync(command, ["version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

export function isDesktopHttpsSupported(options: DesktopHttpsSupportOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return true;
  }

  const commandIsUsable = options.commandIsUsable ?? defaultCommandIsUsable;
  return WINDOWS_OPENSSL_COMMAND_CANDIDATES.some((command) => commandIsUsable(command));
}
