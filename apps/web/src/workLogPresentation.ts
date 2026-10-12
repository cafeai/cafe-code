import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";

/**
 * These keys are the canonical Cafe-authored envelopes minted by runtime
 * ingestion/the command reactor, not a dictionary of provider prose. Keep the
 * received summary untouched for identity, legacy folding, copying and search;
 * only an exact kind/summary pair acquires a translated display value. Unknown
 * kinds, native tool titles and user/provider content remain opaque data.
 */
const CAFE_ACTIVITY_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "approval.requested": {
    get "Command approval requested"() {
      return uiText("Command approval requested");
    },
    get "Terminal input approval requested"() {
      return uiText("Terminal input approval requested");
    },
    get "File-read approval requested"() {
      return uiText("File-read approval requested");
    },
    get "File-change approval requested"() {
      return uiText("File-change approval requested");
    },
    get "Approval requested"() {
      return uiText("Approval requested");
    },
  },
  "approval.resolved": {
    get "Approval resolved"() {
      return uiText("Approval resolved");
    },
  },
  "runtime.error": {
    get "Runtime error"() {
      return uiText("Runtime error");
    },
  },
  "runtime.warning": {
    get "Runtime warning"() {
      return uiText("Runtime warning");
    },
    get "Provider transport retrying"() {
      return uiText("Provider transport retrying");
    },
    get "Provider turn interrupted by restart"() {
      return uiText("Provider turn interrupted by restart");
    },
    get "Live provider turn restored after restart reconciliation"() {
      return uiText("Live provider turn restored after restart reconciliation");
    },
    get "Stranded steer recovered as next turn"() {
      return uiText("Stranded steer recovered as next turn");
    },
    get "Active steer retried as next turn"() {
      return uiText("Active steer retried as next turn");
    },
    get "Turn start routed to active steer"() {
      return uiText("Turn start routed to active steer");
    },
    get "Turn start retried as active steer"() {
      return uiText("Turn start retried as active steer");
    },
    get "Interrupt retargeted to provider active turn"() {
      return uiText("Interrupt retargeted to provider active turn");
    },
    get "Goal pause synchronization deferred"() {
      return uiText("Goal pause synchronization deferred");
    },
    get "Saved input submitted as next turn"() {
      return uiText("Saved input submitted as next turn");
    },
    get "Steer submitted as next turn"() {
      return uiText("Steer submitted as next turn");
    },
    get "Steer retried as next turn"() {
      return uiText("Steer retried as next turn");
    },
    get "Reconnecting interrupted provider work"() {
      return uiText("Reconnecting interrupted provider work");
    },
    get "Reconnecting after a transient provider failure"() {
      return uiText("Reconnecting after a transient provider failure");
    },
    get "Codex recovery is waiting"() {
      return uiText("Codex recovery is waiting");
    },
    get "Codex recovery cancelled"() {
      return uiText("Codex recovery cancelled");
    },
    get "Continuing after a temporary Codex failure"() {
      return uiText("Continuing after a temporary Codex failure");
    },
    get "Codex continuation accepted"() {
      return uiText("Codex continuation accepted");
    },
    get "Codex recovery needs reconciliation"() {
      return uiText("Codex recovery needs reconciliation");
    },
    get "Continuing interrupted provider work"() {
      return uiText("Continuing interrupted provider work");
    },
  },
  "turn.plan.updated": {
    get "Plan updated"() {
      return uiText("Plan updated");
    },
  },
  "user-input.requested": {
    get "User input requested"() {
      return uiText("User input requested");
    },
  },
  "user-input.resolved": {
    get "User input continued automatically"() {
      return uiText("User input continued automatically");
    },
    get "User input submitted"() {
      return uiText("User input submitted");
    },
  },
  "task.started": {
    get "Subagent started"() {
      return uiText("Subagent started");
    },
    get "Plan task started"() {
      return uiText("Plan task started");
    },
    get "Approval review started"() {
      return uiText("Approval review started");
    },
    get "Task started"() {
      return uiText("Task started");
    },
  },
  "task.progress": {
    get "Subagent update"() {
      return uiText("Subagent update");
    },
    get "Reasoning update"() {
      return uiText("Reasoning update");
    },
  },
  "task.completed": {
    get "Subagent failed"() {
      return uiText("Subagent failed");
    },
    get "Task failed"() {
      return uiText("Task failed");
    },
    get "Subagent stopped"() {
      return uiText("Subagent stopped");
    },
    get "Task stopped"() {
      return uiText("Task stopped");
    },
    get "Subagent completed"() {
      return uiText("Subagent completed");
    },
    get "Task completed"() {
      return uiText("Task completed");
    },
  },
  "hook.progress": {
    get "Hook progress"() {
      return uiText("Hook progress");
    },
  },
  "hook.completed": {
    get "Hook failed"() {
      return uiText("Hook failed");
    },
    get "Hook stopped"() {
      return uiText("Hook stopped");
    },
    get "Hook completed"() {
      return uiText("Hook completed");
    },
  },
  "context-compaction": {
    get "Context compacted"() {
      return uiText("Context compacted");
    },
  },
  "context-window.updated": {
    get "Context window updated"() {
      return uiText("Context window updated");
    },
  },
  "review.exited": {
    get "Native review exited"() {
      return uiText("Native review exited");
    },
  },
  "review.started": {
    get "Native review started"() {
      return uiText("Native review started");
    },
  },
  "provider.async-questions": {
    get "Follow-up questions"() {
      return uiText("Follow-up questions");
    },
  },
  "provider.turn.start.failed": {
    get "Provider turn start interrupted"() {
      return uiText("Provider turn start interrupted");
    },
    get "Provider turn start failed"() {
      return uiText("Provider turn start failed");
    },
    get "Provider continuation needs reconciliation"() {
      return uiText("Provider continuation needs reconciliation");
    },
  },
  "provider.turn.steer.failed": {
    get "Provider steer queued"() {
      return uiText("Provider steer queued");
    },
    get "Provider steer failed"() {
      return uiText("Provider steer failed");
    },
    get "Explicit-priority message was not delivered"() {
      return uiText("Explicit-priority message was not delivered");
    },
  },
  "provider.turn.interrupt.completed": {
    get "Provider turn interrupt restored after restart"() {
      return uiText("Provider turn interrupt restored after restart");
    },
    get "Provider turn interrupt completed"() {
      return uiText("Provider turn interrupt completed");
    },
  },
  "provider.turn.interrupt.failed": {
    get "Provider turn interrupt recovery failed"() {
      return uiText("Provider turn interrupt recovery failed");
    },
    get "Provider turn interrupt failed"() {
      return uiText("Provider turn interrupt failed");
    },
  },
  "provider.context.bootstrap.accepted": {
    get "Copied conversation context delivered"() {
      return uiText("Copied conversation context delivered");
    },
  },
  "provider.approval.respond.failed": {
    get "Provider approval response failed"() {
      return uiText("Provider approval response failed");
    },
  },
  "provider.user-input.respond.failed": {
    get "Provider user input response failed"() {
      return uiText("Provider user input response failed");
    },
  },
  "provider.goal.clear.failed": {
    get "Goal was not cleared"() {
      return uiText("Goal was not cleared");
    },
  },
  "provider.goal.replace.failed": {
    get "Goal replacement was not completed"() {
      return uiText("Goal replacement was not completed");
    },
  },
  "provider.goal.set.failed": {
    get "Goal update was not applied"() {
      return uiText("Goal update was not applied");
    },
    get "Send a message before setting a goal in this copied chat"() {
      return uiText("Send a message before setting a goal in this copied chat");
    },
  },
  "provider.compaction.failed": {
    get "Send a message before compacting this copied chat"() {
      return uiText("Send a message before compacting this copied chat");
    },
    get "Compaction could not start"() {
      return uiText("Compaction could not start");
    },
  },
  "provider.compaction.requested": {
    get "Compaction requested"() {
      return uiText("Compaction requested");
    },
  },
};

function ownString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  // Rendering received metadata must not invoke arbitrary property getters.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(payload, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Undefined means the input is opaque, not permission to parse it as ICU. */
export function cafeWorkLogDisplayLabel(activity: OrchestrationThreadActivity): string | undefined {
  const labels = Object.hasOwn(CAFE_ACTIVITY_LABELS, activity.kind)
    ? CAFE_ACTIVITY_LABELS[activity.kind]
    : undefined;
  if (labels && Object.hasOwn(labels, activity.summary)) return labels[activity.summary];
  if (activity.kind === "provider.switched") {
    const from = ownString(activity.payload, "fromDisplayName");
    const to = ownString(activity.payload, "toDisplayName");
    const model = ownString(activity.payload, "toModel");
    if (from && to) {
      const modelSuffix = model ? ` · ${model}` : "";
      const expected =
        from === to
          ? `Switched ${to} provider${modelSuffix}`
          : `Switched from ${from} to ${to}${modelSuffix}`;
      // Exact optional provenance must agree with the unchanged canonical
      // summary. It grants no runtime/action authority and never guesses the
      // account names in historical events that predate these fields.
      if (activity.summary === expected)
        return from === to
          ? uiText("Switched {provider} provider{hasModel, select, yes { · {model}} other {}}", {
              provider: to,
              hasModel: model ? "yes" : "no",
              model: model ?? "",
            })
          : uiText("Switched from {from} to {to}{hasModel, select, yes { · {model}} other {}}", {
              from,
              to,
              hasModel: model ? "yes" : "no",
              model: model ?? "",
            });
    }
    return undefined;
  }
  if (activity.kind === "tool.started" || activity.kind === "tool.completed") {
    if (ownString(activity.payload, "itemType") === "context_compaction") {
      return contextCompactionDisplayLabel(activity.summary);
    }
    const title = ownString(activity.payload, "title");
    if (!title?.trim() && activity.summary === "Tool started") return uiText("Tool started");
    if (!title?.trim() && activity.summary === "Tool") return uiText("Tool");
    if (
      title?.trim() &&
      activity.kind === "tool.started" &&
      activity.summary === `${title} started`
    )
      return uiText("{title} started", { title });
  }
  if (
    activity.kind === "tool.updated" &&
    !ownString(activity.payload, "title") &&
    activity.summary === "Tool updated"
  )
    return uiText("Tool updated");
  if (activity.kind === "hook.started") {
    const name = ownString(activity.payload, "hookName");
    if (name && activity.summary === `${name} started`) return uiText("{name} started", { name });
  }
  if (activity.kind === "task.started") {
    const type = ownString(activity.payload, "taskType");
    if (type && activity.summary === `${type} task started`)
      return uiText("{type} task started", { type });
  }
  return undefined;
}

/** Exact generated compaction titles only; arbitrary native titles are data. */
export function contextCompactionDisplayLabel(label: string): string | undefined {
  switch (label) {
    case "Compacting context":
      return uiText("Compacting context");
    case "Context compaction started":
      return uiText("Context compaction started");
    case "Context compaction failed":
      return uiText("Context compaction failed");
    case "Context compaction interrupted":
      return uiText("Context compaction interrupted");
    case "Context compacted":
      return uiText("Context compacted");
    default:
      return undefined;
  }
}
