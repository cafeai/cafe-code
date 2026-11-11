import type { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { hasCafeSecretReference, redactCafeSecretText } from "@cafecode/shared/cafeSecrets";
import type { ThreadSecretsStore } from "./store.ts";

/** JSON-only transformation preserves each native output schema. No stringify
 * substitution, prototype setters, getters or recursive secret expansion. */
export function mapSecretStrings(value: unknown, transform: (text: string) => string): unknown {
  let nodes = 0;
  let textUnits = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64)
      throw new Error("Cafe Secrets tool data exceeded its safe bound.");
    if (typeof input === "string") {
      const result = transform(input);
      textUnits += result.length;
      if (textUnits > 2_097_152) throw new Error("Cafe Secrets tool data exceeded its safe bound.");
      return result;
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number" ||
      input === undefined
    )
      return input;
    if (typeof input !== "object") throw new Error("Cafe Secrets tool data is unavailable.");
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null)
      throw new Error("Cafe Secrets tool data is unavailable.");
    const output: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : {};
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(input) && key === "length") continue;
      if (!("value" in descriptor)) throw new Error("Cafe Secrets tool data is unavailable.");
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  };
  return visit(value, 0);
}

export function supportsClaudeSecretHooks(version: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version?.trim() ?? "");
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 321)));
}

export function makeClaudeSecretHooks(input: {
  readonly store: ThreadSecretsStore;
  readonly threadId: string;
  readonly nativeVersion: string | null | undefined;
  readonly runnerInvocation: string;
  readonly isCurrent: () => boolean;
  /** An unrepresentable result must close its exact query before it can be
   * submitted to a model, rather than return a replacement of an invalid shape. */
  readonly retire: () => Promise<void>;
}) {
  let retired = false;
  const seen = new Map<string, string>();
  const outputReplacement = supportsClaudeSecretHooks(input.nativeVersion);
  const current = () => !retired && input.isCurrent();
  const remember = (values: ReadonlyMap<string, string>) => {
    for (const [id, value] of values) {
      if (!seen.has(value) && seen.size >= 128)
        throw new Error(
          "Cafe Secrets rotation limit reached for this query. Use the secret runner.",
        );
      seen.set(value, id);
    }
  };
  const redact = (value: unknown) => {
    if (seen.size === 0) return value;
    const entries = [...seen].map(([value, id]) => [id, value] as const);
    const minimum = Math.min(...entries.map(([, text]) => text.length));
    return mapSecretStrings(value, (text) =>
      text.length < minimum ? text : redactCafeSecretText(text, entries),
    );
  };
  const pre: HookCallback = async (event, _id, options) => {
    if (event.hook_event_name !== "PreToolUse") return {};
    let references = false;
    try {
      if (!current() || options.signal.aborted)
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "This Cafe Secrets query has retired.",
          },
        };
      mapSecretStrings(event.tool_input, (text) => {
        references ||= hasCafeSecretReference(text);
        return text;
      });
      const command =
        event.tool_input && typeof event.tool_input === "object"
          ? Object.getOwnPropertyDescriptor(event.tool_input, "command")?.value
          : undefined;
      const runnerCall =
        (event.tool_name === "Bash" || event.tool_name === "PowerShell") &&
        typeof command === "string" &&
        command.startsWith(`${input.runnerInvocation} `);
      if (
        (event.tool_name === "Bash" || event.tool_name === "PowerShell") &&
        typeof command === "string" &&
        command.includes("bin.mjs") &&
        /\s--cafe-secret-exec\s/.test(command) &&
        !runnerCall
      )
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `That Cafe Secrets runner is no longer current. Use this exact chat's helper: ${input.runnerInvocation} '<JSON request>'`,
          },
        };
      if (runnerCall && !outputReplacement) return {};
      if (!outputReplacement)
        return references
          ? {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: `Use this exact chat's Cafe Secrets helper: ${input.runnerInvocation} '<JSON request>'`,
              },
            }
          : {};
      const values = await input.store.snapshot(input.threadId);
      if (!current() || options.signal.aborted) throw new Error();
      remember(values);
      if (runnerCall) return {};
      if (!references) return {};
      // Delegation and other control tools pass opaque references as data.
      // Their native identities and permission/control semantics stay intact.
      if (
        !/^(Bash|PowerShell|Read|Write|Edit|Glob|Grep)$/.test(event.tool_name) &&
        !event.tool_name.startsWith("mcp__")
      )
        return {};
      // Keep the native tool's recorded arguments opaque as well as its model
      // output. The runner is the value-expansion boundary for both providers;
      // the hook never converts a reference into a native permission grant.
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Use this exact chat's Cafe Secrets helper: ${input.runnerInvocation} '<JSON request>'. Use env/stdin, write_file, or read_file as appropriate.`,
        },
      };
    } catch {
      if (!references && current() && !options.signal.aborted) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Cafe Secrets could not prepare this tool call. Use the chat's secret runner or restore the missing reference.",
        },
      };
    }
  };
  const post: HookCallback = async (event) => {
    if (event.hook_event_name !== "PostToolUse" || !outputReplacement || seen.size === 0) return {};
    if (
      !/^(Bash|PowerShell|Read|Write|Edit|Glob|Grep)$/.test(event.tool_name) &&
      !event.tool_name.startsWith("mcp__")
    )
      return {};
    try {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: redact(event.tool_response),
        },
      };
    } catch {
      retired = true;
      try {
        await input.retire();
      } catch {
        /* Keep native close errors opaque. The exact owner remains retired. */
      }
      throw new Error(
        "Cafe Secrets retired its query because a tool result could not be redacted safely.",
      );
    }
  };
  return {
    hooks: { PreToolUse: [{ hooks: [pre] }], PostToolUse: [{ hooks: [post] }] } satisfies Partial<
      Record<HookEvent, HookCallbackMatcher[]>
    >,
    retire: () => {
      retired = true;
    },
    hasValues: () => seen.size > 0,
    redact,
  };
}
