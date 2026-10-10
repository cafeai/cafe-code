import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { sanitizePlanText } from "./taskProgressPresentation";

export interface ProviderTaskPresentation {
  title: string;
  kind: "agent" | "command" | "tool";
}

/** Received labels are presentation, not task identity. Read only inert own
 * fields and never serialize inputs, invoke accessors or inspect tool results
 * just to give a card a name. In particular, an initial empty input is normal
 * while Claude streams its arguments, not a failed or completed task. */
function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Share the existing provider-text filter: remove invisible terminal/bidi
  // controls without altering printable text or natural-language joiners.
  const bounded = sanitizePlanText(value.slice(0, 300)).trim();
  return bounded || undefined;
}

/** Keep useful public descriptions/commands intact, including literal braces.
 * Only the exact empty-object placeholder receives a neutral fallback. The
 * same resolver serves controlled, read-only and foreground-only task lanes;
 * formatting cannot manufacture liveness or a mutation capability. */
export function readProviderTaskPresentation(
  activity: Pick<OrchestrationThreadActivity, "payload" | "summary">,
  preferredTitle?: string,
): ProviderTaskPresentation {
  const payload = ownValue(activity, "payload");
  const toolName = label(ownValue(ownValue(payload, "data"), "toolName"));
  const itemType = ownValue(payload, "itemType");
  const detail = label(preferredTitle) ?? label(ownValue(payload, "detail"));
  const summary = label(ownValue(activity, "summary"));
  const title = detail ?? summary ?? label(ownValue(payload, "title"));
  const placeholder = title?.match(/^(?:(Agent|Task|Bash):\s*)?\{\s*\}$/iu);
  // Legacy persisted events can lack a structured tool name. Its exact empty
  // placeholder spelling may select an inert icon/fallback, never controls.
  const displayTool = (toolName ?? placeholder?.[1]?.trim())?.toLowerCase();
  const kind =
    displayTool === "agent" || displayTool === "task" || itemType === "collab_agent_tool_call"
      ? "agent"
      : displayTool === "bash" || itemType === "command_execution"
        ? "command"
        : "tool";
  return {
    kind,
    title:
      title && !placeholder
        ? title
        : kind === "agent"
          ? "Agent task"
          : kind === "command"
            ? "Shell command"
            : "Provider task",
  };
}
