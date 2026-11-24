import { uiText } from "@cafecode/shared/i18n";
import { summarizeToolArguments } from "@cafecode/shared/toolActivity";

type WebMcpAction =
  | "search"
  | "images"
  | "open"
  | "click"
  | "find"
  | "screenshot"
  | "time"
  | "browse";
export interface WebMcpInvocation {
  readonly action?: WebMcpAction;
  readonly preview?: string;
  readonly failed: boolean;
}
export interface WebMcpHistoryAction {
  readonly action: WebMcpAction;
  readonly preview?: string;
  readonly state: "running" | "completed" | "failed";
}

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const encodedNames = new Set([
  "codex_apps.search_service.web_run",
  "mcp__codex_apps__search_service.web_run",
  "mcp__codex_apps__search_service_web_run",
]);
const commands = [
  ["system2_search_query", "search", "q"],
  ["search_query", "search", "q"],
  ["image_query", "images", "q"],
  ["open", "open", "ref_id"],
  ["click", "click", undefined],
  ["find", "find", "pattern"],
  ["screenshot", "screenshot", undefined],
  ["time", "time", "utc_offset"],
] as const;

/** Presentation only: match retained invocation metadata, never titles, detail
 * prose or result text. A recognized name grants no server or tool authority.
 * Undefined means no invocation metadata; null explicitly clears a prior match. */
export function readWebMcpInvocation(payload: unknown): WebMcpInvocation | null | undefined {
  const itemType = own(payload, "itemType");
  if (itemType !== "mcp_tool_call" && itemType !== "dynamic_tool_call") return undefined;
  const data = own(payload, "data");
  const item = own(data, "item");
  const rawInput = own(data, "rawInput");
  const server = own(item, "server") ?? own(item, "namespace");
  const tool = own(item, "tool");
  const name = own(data, "toolName") ?? own(data, "tool") ?? own(rawInput, "tool_name");
  if (server === undefined && tool === undefined && name === undefined) return undefined;
  const recognized =
    server !== undefined || tool !== undefined
      ? (server === "codex_apps" && tool === "search_service.web_run") ||
        (server === "codex_apps.search_service" && tool === "web_run")
      : typeof name === "string" && encodedNames.has(name);
  if (!recognized) return null;

  const result = own(item, "result");
  const error = own(item, "error");
  const failed =
    own(payload, "status") === "declined" ||
    own(result, "isError") === true ||
    (typeof error === "string" && error.length > 0) ||
    (error !== null && typeof error === "object");
  let args = own(item, "arguments") ?? own(data, "input") ?? own(rawInput, "tool_input");
  // Some retained providers encode arguments as JSON. Bound parsing and never
  // reconstruct an invocation by parsing its already-truncated display detail.
  if (typeof args === "string") {
    try {
      args = args.length <= 65_536 ? JSON.parse(args) : null;
    } catch {
      args = null;
    }
  }
  // Terminal snapshots can omit arguments; preserve the prior admitted action
  // when folding that same operation instead of replacing it with generic copy.
  if (args === undefined) return { failed };
  const active = commands.filter(([key]) => {
    const entries = own(args, key);
    const length = own(entries, "length");
    return Array.isArray(entries) && typeof length === "number" && length > 0;
  });
  const actions = new Set(active.map(([, action]) => action));
  if (actions.size !== 1) return { action: "browse", failed };
  const action = active[0]![1];
  const previews: string[] = [];
  for (const [key, , field] of active) {
    if (!field) continue;
    const entries = own(args, key);
    for (let index = 0; index < 3 && previews.length < 3; index++) {
      const value = own(own(entries, String(index)), field);
      if (typeof value !== "string") continue;
      const bounded = value.slice(0, 4_096).trim();
      if (!bounded) continue;
      // Native reference IDs are useful in inspection, not compact row copy.
      if (action === "open" && !/^https?:\/\//iu.test(bounded)) continue;
      previews.push(bounded);
    }
  }
  const preview = summarizeToolArguments(previews.join(" · "));
  return { action, failed, ...(preview ? { preview } : {}) };
}

export function webMcpHistoryTitle({ action, state }: WebMcpHistoryAction): string {
  switch (action) {
    case "search":
      return uiText(
        "{state, select, running {Searching the web} completed {Searched the web} other {Could not search the web}}",
        { state },
      );
    case "images":
      return uiText(
        "{state, select, running {Searching for images} completed {Searched for images} other {Could not search for images}}",
        { state },
      );
    case "open":
      return uiText(
        "{state, select, running {Opening web pages} completed {Opened web pages} other {Could not open web pages}}",
        { state },
      );
    case "click":
      return uiText(
        "{state, select, running {Following web links} completed {Followed web links} other {Could not follow web links}}",
        { state },
      );
    case "find":
      return uiText(
        "{state, select, running {Searching within web pages} completed {Searched within web pages} other {Could not search within web pages}}",
        { state },
      );
    case "screenshot":
      return uiText(
        "{state, select, running {Taking page screenshots} completed {Took page screenshots} other {Could not take page screenshots}}",
        { state },
      );
    case "time":
      return uiText(
        "{state, select, running {Checking the time} completed {Checked the time} other {Could not check the time}}",
        { state },
      );
    case "browse":
      return uiText(
        "{state, select, running {Browsing the web} completed {Browsed the web} other {Could not browse the web}}",
        { state },
      );
  }
}
