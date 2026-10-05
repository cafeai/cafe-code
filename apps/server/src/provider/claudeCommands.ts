import { createHash } from "node:crypto";
import {
  ClaudeSettings,
  type ProviderCommandCatalog,
  type ProviderInstanceEnvironment,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

/** Private commitment carried only between Cafe backend/daemon inventories.
 * Bind the query to admitted settings even during asynchronous registry
 * reconciliation. Default expansion and sorted entries make presentation-only
 * setting edits irrelevant. Never expose this commitment in the picker API. */
export function claudeCommandsConfigurationKey(input: {
  readonly config: unknown;
  readonly environment?: ProviderInstanceEnvironment;
  readonly enabled: boolean | undefined;
}): string {
  const config = Schema.decodeUnknownSync(ClaudeSettings)(input.config);
  const environment = (input.environment ?? [])
    .map(({ name, value }) => [name, value] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update("cafe.claude-command-catalog.configuration.v1\0")
    .update(
      JSON.stringify([
        input.enabled ?? config.enabled,
        Object.entries(config).toSorted(([a], [b]) => a.localeCompare(b)),
        environment,
      ]),
    )
    .digest("hex");
}

export const UNAVAILABLE_COMMAND_CATALOG: ProviderCommandCatalog = {
  status: "unavailable",
  commands: [],
};
const UNSAFE_LABEL = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
function label(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length > limit || UNSAFE_LABEL.test(value)) return;
  return value.trim() || undefined;
}

/** SDK 0.3.288's commands_changed is a complete replacement, including empty
 * lists. Reject oversized or malformed snapshots rather than claiming that a
 * truncated catalog is current. Unknown fields (paths, plugin internals, etc.)
 * never cross this boundary. Unsafe individual tokens are omitted unchanged. */
export function publicClaudeCommands(value: unknown): ProviderCommandCatalog {
  if (!Array.isArray(value) || value.length > 512) return UNAVAILABLE_COMMAND_CATALOG;
  const commands: Array<ProviderCommandCatalog["commands"][number]> = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
      return UNAVAILABLE_COMMAND_CATALOG;
    const { name, description, argumentHint } = candidate as Record<string, unknown>;
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(name)) continue;
    // Native lookup can be case-sensitive. Never merge names by lowercasing.
    if (seen.has(name)) continue;
    seen.add(name);
    const safeDescription = label(description, 512);
    const safeHint = label(argumentHint, 256);
    commands.push({
      name,
      ...(safeDescription ? { description: safeDescription } : {}),
      ...(safeHint ? { input: { hint: safeHint } } : {}),
    });
  }
  return { status: commands.length ? "available" : "empty", commands };
}
