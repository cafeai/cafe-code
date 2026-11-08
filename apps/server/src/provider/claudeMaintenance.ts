import { ProviderDriverKind } from "@cafecode/contracts";
import {
  normalizeCommandPath,
  type PackageManagedProviderMaintenanceDefinition,
} from "./providerMaintenance.ts";

/** One source-owned package/channel policy for the driver and login launcher.
 * The native updater predicate and package-manager precedence remain unchanged.
 * Homebrew stable and latest are distinct installed casks; only an observed
 * allowlisted Caskroom target may select the corresponding fixed upgrade arg.
 */
export const CLAUDE_PROVIDER_MAINTENANCE = {
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  homebrewCasks: { binaryName: "claude", names: ["claude-code", "claude-code@latest"] },
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: (commandPath: string): boolean => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude") ||
        normalized.endsWith("/.local/bin/claude.exe") ||
        normalized.includes("/.local/share/claude/")
      );
    },
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;
