import type {
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
} from "@cafecode/contracts";
import { McpToolError } from "./results.ts";

export interface EnvironmentPatch {
  readonly name: string;
  readonly value?: string | undefined;
  readonly sensitive?: boolean | undefined;
  readonly valueRedacted?: boolean | undefined;
  readonly clear?: boolean | undefined;
}

/** A read/edit/write of redacted settings must never turn a hidden value into
 * deletion. Entries are patches by exact variable name; omission preserves
 * both other variables and the existing secret-store preservation witness. */
export function patchProviderEnvironment(
  existing: ProviderInstanceConfig["environment"],
  patches: readonly EnvironmentPatch[] | undefined,
  clearNames: readonly string[] = [],
) {
  if (patches === undefined && clearNames.length === 0) return existing;
  const values = new Map((existing ?? []).map((entry) => [entry.name, entry]));
  const seen = new Set<string>();
  for (const name of clearNames) {
    if (seen.has(name))
      throw new McpToolError("invalid_request", "An environment name occurs more than once.");
    seen.add(name);
    values.delete(name);
  }
  for (const patch of patches ?? []) {
    if (seen.has(patch.name))
      throw new McpToolError(
        "invalid_request",
        "An environment name occurs more than once or is both updated and cleared.",
      );
    seen.add(patch.name);
    const previous = values.get(patch.name);
    if (patch.clear) {
      if ((patch.value !== undefined && patch.value !== "") || patch.valueRedacted)
        throw new McpToolError(
          "invalid_request",
          "A cleared environment variable cannot also supply a value or redaction marker.",
        );
      values.delete(patch.name);
      continue;
    }
    const sensitive = patch.sensitive ?? previous?.sensitive ?? false;
    if (
      patch.valueRedacted &&
      ((patch.value !== undefined && patch.value !== "") || !previous?.sensitive || !sensitive)
    )
      throw new McpToolError(
        "invalid_request",
        "A redaction marker can only preserve an existing sensitive variable.",
      );
    if (
      previous?.sensitive &&
      (patch.valueRedacted || patch.value === undefined || patch.value === "")
    ) {
      if (!sensitive)
        throw new McpToolError(
          "invalid_request",
          "Supply an explicit replacement value to change a sensitive variable's classification.",
        );
      values.set(patch.name, previous);
      continue;
    }
    if (sensitive && !patch.value)
      throw new McpToolError(
        "invalid_request",
        "A new sensitive variable requires a nonempty value; use clear=true to remove one.",
      );
    values.set(patch.name, {
      name: patch.name,
      value: patch.value ?? previous?.value ?? "",
      sensitive,
    } satisfies ProviderInstanceEnvironmentVariable);
  }
  return [...values.values()];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};

/** Driver config is a shallow field patch. OpenCode's native password is the
 * one config secret managed by ServerSettings; retain its witness even during
 * an explicit config replacement unless its exact field is explicitly cleared. */
export function patchProviderConfig(
  existing: unknown,
  input: Record<string, unknown> | undefined,
  clearKeys: readonly string[],
  replace: boolean,
  driver: string,
): unknown {
  if (input === undefined && clearKeys.length === 0 && !replace) return existing;
  const prior = record(existing);
  const next = { ...(replace ? {} : prior), ...input };
  const clear = new Set(clearKeys);
  for (const key of clear) {
    if (input && Object.hasOwn(input, key))
      throw new McpToolError(
        "invalid_request",
        "A config field cannot be both updated and cleared.",
      );
    delete next[key];
  }
  if (driver === "opencode") {
    if (clear.has("serverPasswordRedacted"))
      throw new McpToolError(
        "invalid_request",
        "Clear serverPassword explicitly instead of removing its redaction marker.",
      );
    if (clear.has("serverPassword")) {
      next.serverPassword = "";
      next.serverPasswordRedacted = false;
    } else if (
      (prior.serverPasswordRedacted === true ||
        (typeof prior.serverPassword === "string" && prior.serverPassword.length > 0)) &&
      (input?.serverPassword === undefined || input.serverPassword === "")
    ) {
      next.serverPassword = prior.serverPassword ?? "";
      next.serverPasswordRedacted = true;
    }
  }
  return next;
}
