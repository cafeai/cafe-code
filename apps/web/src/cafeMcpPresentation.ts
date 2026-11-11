import { uiText } from "@cafecode/shared/i18n";

/** Presentation only. Recognizing an invocation name never authenticates its
 * server, grants management authority or confirms native/provider adoption. */
const ACTIONS = {
  list_projects: "projects",
  get_project: "project",
  list_threads: "threads",
  get_thread: "thread",
  get_cafe_context: "context",
  get_thread_status: "status",
  wait_for_thread: "wait",
  get_thread_usage: "usage",
  list_providers: "providers",
  list_provider_models: "models",
  get_provider_settings: "settings",
  get_operation: "receipt",
  list_thread_questions: "questions",
  get_thread_question: "question",
  create_project: "createProject",
  update_project: "updateProject",
  delete_project: "deleteProject",
  create_thread: "createThread",
  update_thread: "updateThread",
  archive_thread: "archiveThread",
  unarchive_thread: "unarchiveThread",
  delete_thread: "deleteThread",
  restore_thread: "restoreThread",
  create_thread_group: "createGroup",
  list_thread_groups: "groups",
  delete_thread_group: "deleteGroup",
  restore_thread_group: "restoreGroup",
  send_message: "message",
  interrupt_thread: "interrupt",
  set_provider_settings: "updateSettings",
  restart_provider: "restart",
  restart_provider_and_resume: "restartResume",
  answer_thread_question: "answer",
  skip_thread_question: "skip",
  clear_thread_question: "dismiss",
  list_scheduled_followups: "schedules",
  request_scheduled_followup: "schedule",
  pause_scheduled_followup: "pauseSchedule",
} as const;
export type CafeMcpTool = keyof typeof ACTIONS;
export interface CafeMcpHistoryAction {
  readonly tool: CafeMcpTool;
  readonly state: "running" | "completed" | "failed";
}

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}
const namespace = /^cafe[-_]code(?:[-_][a-f0-9]{16})?$/u;
const encoded =
  /^(?:mcp__)?(?<server>cafe[-_]code(?:[-_][a-f0-9]{16})?)(?:__|[._])(?<tool>[a-z][a-z0-9_]{0,95})$/u;

/** Read only retained invocation metadata: Codex's structured item, Claude's
 * toolName, OpenCode's tool, or ACP's rawInput.tool_name. Titles, arguments,
 * result prose and root completion cannot invent an invocation or success. */
export function readCafeMcpInvocation(
  payload: unknown,
): { tool: CafeMcpTool | null; failed: boolean } | undefined {
  const itemType = own(payload, "itemType");
  if (itemType !== "mcp_tool_call" && itemType !== "dynamic_tool_call") return undefined;
  const data = own(payload, "data");
  const item = own(data, "item");
  const rawInput = own(data, "rawInput");
  const rawServer = own(item, "server") ?? own(item, "namespace");
  const server = text(rawServer);
  const itemTool = text(own(item, "tool"));
  const name =
    text(own(data, "toolName")) ?? text(own(data, "tool")) ?? text(own(rawInput, "tool_name"));
  let candidate: string | undefined;
  if (server && itemTool && namespace.test(server)) candidate = itemTool;
  else if (rawServer === undefined && itemTool === undefined && name)
    candidate = encoded.exec(name)?.groups?.tool;
  if (server === undefined && itemTool === undefined && name === undefined) return undefined;
  const result = own(item, "result");
  const error = own(item, "error");
  return {
    tool: candidate && Object.hasOwn(ACTIONS, candidate) ? (candidate as CafeMcpTool) : null,
    failed:
      own(payload, "status") === "declined" ||
      own(result, "isError") === true ||
      (typeof error === "string" && error.length > 0) ||
      (error !== null && typeof error === "object"),
  };
}

/** Fixed authored messages keep translation and action wording independent of
 * provider/user prose. Mutation completion describes the MCP action's receipt;
 * callbacks, interrupts and restarts keep their asynchronous request semantics. */
export function cafeMcpHistoryTitle({ tool, state }: CafeMcpHistoryAction): string {
  switch (ACTIONS[tool]) {
    case "projects":
      return uiText(
        "{state, select, running {Viewing Cafe Code projects} completed {Viewed Cafe Code projects} other {Could not view Cafe Code projects}}",
        { state },
      );
    case "project":
      return uiText(
        "{state, select, running {Viewing Cafe Code project} completed {Viewed Cafe Code project} other {Could not view Cafe Code project}}",
        { state },
      );
    case "threads":
      return uiText(
        "{state, select, running {Viewing Cafe Code threads} completed {Viewed Cafe Code threads} other {Could not view Cafe Code threads}}",
        { state },
      );
    case "thread":
      return uiText(
        "{state, select, running {Viewing Cafe Code thread} completed {Viewed Cafe Code thread} other {Could not view Cafe Code thread}}",
        { state },
      );
    case "context":
      return uiText(
        "{state, select, running {Viewing Cafe Code chat context} completed {Viewed Cafe Code chat context} other {Could not view Cafe Code chat context}}",
        { state },
      );
    case "status":
      return uiText(
        "{state, select, running {Checking Cafe Code thread status} completed {Checked Cafe Code thread status} other {Could not check Cafe Code thread status}}",
        { state },
      );
    case "wait":
      return uiText(
        "{state, select, running {Waiting for Cafe Code thread changes} completed {Waited for Cafe Code thread changes} other {Could not wait for Cafe Code thread changes}}",
        { state },
      );
    case "usage":
      return uiText(
        "{state, select, running {Checking Cafe Code context and quota} completed {Checked Cafe Code context and quota} other {Could not check Cafe Code context and quota}}",
        { state },
      );
    case "providers":
      return uiText(
        "{state, select, running {Viewing Cafe Code providers} completed {Viewed Cafe Code providers} other {Could not view Cafe Code providers}}",
        { state },
      );
    case "models":
      return uiText(
        "{state, select, running {Viewing Cafe Code provider models} completed {Viewed Cafe Code provider models} other {Could not view Cafe Code provider models}}",
        { state },
      );
    case "settings":
      return uiText(
        "{state, select, running {Viewing Cafe Code provider settings} completed {Viewed Cafe Code provider settings} other {Could not view Cafe Code provider settings}}",
        { state },
      );
    case "receipt":
      return uiText(
        "{state, select, running {Checking Cafe Code action receipt} completed {Checked Cafe Code action receipt} other {Could not check Cafe Code action receipt}}",
        { state },
      );
    case "questions":
      return uiText(
        "{state, select, running {Viewing Cafe Code questions} completed {Viewed Cafe Code questions} other {Could not view Cafe Code questions}}",
        { state },
      );
    case "question":
      return uiText(
        "{state, select, running {Viewing Cafe Code question} completed {Viewed Cafe Code question} other {Could not view Cafe Code question}}",
        { state },
      );
    case "createProject":
      return uiText(
        "{state, select, running {Creating Cafe Code project} completed {Created Cafe Code project} other {Could not create Cafe Code project}}",
        { state },
      );
    case "updateProject":
      return uiText(
        "{state, select, running {Updating Cafe Code project} completed {Updated Cafe Code project} other {Could not update Cafe Code project}}",
        { state },
      );
    case "deleteProject":
      return uiText(
        "{state, select, running {Deleting Cafe Code project} completed {Deleted Cafe Code project} other {Could not delete Cafe Code project}}",
        { state },
      );
    case "createThread":
      return uiText(
        "{state, select, running {Creating Cafe Code thread} completed {Created Cafe Code thread} other {Could not create Cafe Code thread}}",
        { state },
      );
    case "updateThread":
      return uiText(
        "{state, select, running {Updating Cafe Code thread} completed {Updated Cafe Code thread} other {Could not update Cafe Code thread}}",
        { state },
      );
    case "archiveThread":
      return uiText(
        "{state, select, running {Archiving Cafe Code thread} completed {Archived Cafe Code thread} other {Could not archive Cafe Code thread}}",
        { state },
      );
    case "unarchiveThread":
      return uiText(
        "{state, select, running {Unarchiving Cafe Code thread} completed {Unarchived Cafe Code thread} other {Could not unarchive Cafe Code thread}}",
        { state },
      );
    case "deleteThread":
      return uiText(
        "{state, select, running {Deleting Cafe Code thread} completed {Deleted Cafe Code thread} other {Could not delete Cafe Code thread}}",
        { state },
      );
    case "restoreThread":
      return uiText(
        "{state, select, running {Restoring Cafe Code thread} completed {Restored Cafe Code thread} other {Could not restore Cafe Code thread}}",
        { state },
      );
    case "createGroup":
      return uiText(
        "{state, select, running {Creating Cafe Code thread group} completed {Created Cafe Code thread group} other {Could not create Cafe Code thread group}}",
        { state },
      );
    case "groups":
      return uiText(
        "{state, select, running {Viewing Cafe Code thread groups} completed {Viewed Cafe Code thread groups} other {Could not view Cafe Code thread groups}}",
        { state },
      );
    case "deleteGroup":
      return uiText(
        "{state, select, running {Deleting Cafe Code thread group} completed {Deleted Cafe Code thread group} other {Could not delete Cafe Code thread group}}",
        { state },
      );
    case "restoreGroup":
      return uiText(
        "{state, select, running {Restoring Cafe Code thread group} completed {Restored Cafe Code thread group} other {Could not restore Cafe Code thread group}}",
        { state },
      );
    case "message":
      return uiText(
        "{state, select, running {Submitting Cafe Code message} completed {Submitted Cafe Code message} other {Could not submit Cafe Code message}}",
        { state },
      );
    case "interrupt":
      return uiText(
        "{state, select, running {Requesting Cafe Code thread interruption} completed {Requested Cafe Code thread interruption} other {Could not request Cafe Code thread interruption}}",
        { state },
      );
    case "updateSettings":
      return uiText(
        "{state, select, running {Updating Cafe Code provider settings} completed {Updated Cafe Code provider settings} other {Could not update Cafe Code provider settings}}",
        { state },
      );
    case "restart":
      return uiText(
        "{state, select, running {Requesting Cafe Code provider restart} completed {Requested Cafe Code provider restart} other {Could not request Cafe Code provider restart}}",
        { state },
      );
    case "restartResume":
      return uiText(
        "{state, select, running {Requesting Cafe Code provider restart and resume} completed {Requested Cafe Code provider restart and resume} other {Could not request Cafe Code provider restart and resume}}",
        { state },
      );
    case "answer":
      return uiText(
        "{state, select, running {Submitting Cafe Code answer} completed {Submitted Cafe Code answer} other {Could not submit Cafe Code answer}}",
        { state },
      );
    case "skip":
      return uiText(
        "{state, select, running {Requesting Cafe Code question skip} completed {Requested Cafe Code question skip} other {Could not request Cafe Code question skip}}",
        { state },
      );
    case "dismiss":
      return uiText(
        "{state, select, running {Requesting Cafe Code question dismissal} completed {Requested Cafe Code question dismissal} other {Could not request Cafe Code question dismissal}}",
        { state },
      );
    case "schedules":
      return uiText(
        "{state, select, running {Viewing Cafe Code scheduled follow-ups} completed {Viewed Cafe Code scheduled follow-ups} other {Could not view Cafe Code scheduled follow-ups}}",
        { state },
      );
    case "schedule":
      return uiText(
        "{state, select, running {Proposing Cafe Code follow-up} completed {Proposed Cafe Code follow-up} other {Could not propose Cafe Code follow-up}}",
        { state },
      );
    case "pauseSchedule":
      return uiText(
        "{state, select, running {Pausing Cafe Code scheduled follow-up} completed {Paused Cafe Code scheduled follow-up} other {Could not pause Cafe Code scheduled follow-up}}",
        { state },
      );
  }
}
